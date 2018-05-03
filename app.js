const fs = require('fs');
const http = require('http');
const AWS = require('aws-sdk');
const wav = require('wav');
const {Pool} = require('pg');
const stream = require('stream');
const sox = require('sox-stream');
const s3Upload = require('s3-upload-stream');
const PREVIEW_RESOLUTION = 64;
const POLL_FREQUENCY = 1000;

start(); 
let handle;
async function start(){
        const secrets = fs.readFileSync('./secrets.config','utf8');
    if(secrets){
        secrets.split('\n').forEach(line=>{
            const pair = line.split("="); 
            process.env[pair[0]] = pair[1];
        });
    }
    if(!process.env.PGPASSWORD){
        process.env.PGPASSWORD = null;
    }
    const S3 = new AWS.S3({region: process.env.S3_REGION});
    const SQS = new AWS.SQS({region: process.env.SQS_REGION});
    SQS.getQueueUrl({QueueName: process.env.QUEUE_NAME},
        (err,data)=>{
            //poll(S3, SQS, data.QueueUrl);
            handle = setInterval(()=>poll(S3, SQS, data.QueueUrl), POLL_FREQUENCY);
    });
}

async function poll(S3, SQS, QueueUrl){
    SQS.receiveMessage({
        QueueUrl,
        MessageAttributeNames: ["temporaryFilename", "trackId"]
    }, (err, data)=>{
        if(data.Messages){
            processAudio(
                S3,
                data.Messages[0].MessageAttributes.temporaryFilename.StringValue,
                data.Messages[0].MessageAttributes.trackId.StringValue
            )
            .then(
                SQS.deleteMessage({
                    QueueUrl,
                    ReceiptHandle: data.Messages[0].ReceiptHandle
                })
            );
        }
    });
}

/* Converting Audio / Generating a Preview:
 * 
 * we will pipe the streams around like so:
 * http request ----->mp3 format------>http put
 *            \
 *             \----->wav format------>generate preview
 * 
 * this way we don't have to hold anything on the disk,
 * and if we are able to start processing bytes as they come in, 
 * we don't have to hold the whole file in memory at once
 * 
 */
async function processAudio(S3, temporaryFilename, trackId){
    clearInterval(handle);
    const pool = await new Pool();
    let inputStream = S3.getObject({
        Bucket: process.env.S3_BUCKET,
        Key: `tracks/temp/${temporaryFilename}`
    }).createReadStream();
    const outputStream = s3Upload(S3).upload({
        Bucket: process.env.S3_BUCKET,
        Key: `tracks/${trackId}.mp3`
    });
    let type = temporaryFilename.split(".");
    type = type[type.length - 1];
    const convertToWav = sox({
        input: {
            type
        },
        output:{
            rate: 44100,
            channels: 1,
            type: 'wav'
        }
    });
    const convertToMp3 = sox({
        input:{
            type
        },
        output:{
            rate: 44100,
            channels: 2,
            type: 'mp3'
        }
    });
    const preview= new PreviewGenerator();

    inputStream.pipe(convertToWav).pipe(preview);
    inputStream.pipe(convertToMp3).pipe(outputStream);

    return new Promise((resolve, reject)=>{
        let onComplete = completeAudioProcess({S3, temporaryFilename, preview, trackId, pool})(resolve);
        preview.on("finish",()=>{let p = preview;debugger; onComplete = onComplete()});
        outputStream.on("uploaded", ()=>{let w = convertToWav; let m = convertToMp3;    let p = preview; debugger; onComplete = onComplete()});
        destroyStreamsOnError([inputStream, convertToWav, convertToMp3, preview, outputStream])(reject);
    });
}

const destroyStreamsOnError = streams => reject =>{
    streams.forEach(stream =>{
        stream.on("error", err=>{
            debugger;
            streams.forEach(otherStream => otherStream.destroy(err));
            reject(err);
        });
    });
}
const completeAudioProcess = ({S3, temporaryFilename, trackId, preview, pool})=> resolve => stream1Ended => stream2Ended =>{
    debugger;
    S3.deleteObject({Bucket: process.env.S3_BUCKET, Key: `tracks/temp/${temporaryFilename}`}, (err, data) => {
        debugger;
        if(!err){
            pool.query(`UPDATE Tracks SET processed = true, waveform = ARRAY[${preview.results}] WHERE id = ${trackId};`)
            .then(() => resolve());
        }
    });
} 


//A class that buffers a .wav file's octets and generates a preview from them as they are streamed through
//this is dependent upon the output of sox-strem being consistent
// if there are problems make sure the package version is locked to 2.0.1
class PreviewGenerator extends stream.Writable{
    constructor(options){
        super();
        const defaults={
            numChannels: 2,
            numBytes: 0,
            bytesPerSample: 4   
        };
        
        this.phase = "header";
        options = Object.assign({}, defaults, options);
        this._numChannels = options.numChannels;
        this._numBytes = options.numBytes;
        this._bytesPerSample = options.bytesPerSample;
        this._resolution = PREVIEW_RESOLUTION;
        this._windowResolution = 8;

        this._windows = Array(this._windowResolution);
        this.results = Array(this._resolution);

        this._windowIdx = 0;
        this._byteNumber = 0;
        this._sample = 0;
        this._sampleNumber = 0;
        this._windowMax = 0;
        this._resultIdx = 0;

        this._headerSection = 0;
        this._headerOffset = 0;
        this._header = [
            {name: "chunkId", data: "", size: 4, ascii: true, constraint: "RIFF"},
            {name: "totalSize", data: 0, size: 4},
            {name: "format", data: "", size: 4, ascii: true, constraint: "WAVE"},
            {name: "formatSectionId", data: "", size: 4, ascii: true, constraint: "fmt "},
            {name: "formatSectionSize", data: 0, size: 4},
            {name: "audioFormat", data: 0, size: 2, constraint: 1},
            {name: "numChannels", data: 0, size: 2},
            {name: "sampleRate", data: 0, size: 4},
            {name: "byteRate", data: 0, size: 4},
            {name: "blockAlign", data: 0, size: 2},
            {name: "bitsPerSample", data: 0, size: 2},
            {name: "dataSectionId", data: 0, size: 4, constraint: "data"},
            {name: "dataLength", data: 0, size: 4}
        ]
    }
    _readHeader(octet){
        const section = this._header[this._headerSection];
        if(section.ascii){
            section.data += String.fromCharCode(octet);
        }
        else{
            section.data |= octet << this._headerOffset * 8;
        }
        ++this._headerOffset;
        if(this._headerOffset === section.size){
            ++this._headerSection;
            this._headerOffset = 0;
        }
        if(this._headerSection === this._header.length){
            const processedHeader = {};
            for(let i = 0; i < this._header.length; ++i){
                processedHeader[this._header[i].name] = this._header[i];
            }
            this._header = processedHeader;
            this._samplesPerWindow = Math.floor(
                this._header.dataLength.data / this._header.blockAlign.data /
                this._header.numChannels.data / this._resolution /
                 this._windowResolution);
            this._maxAmplitude = 0;
            for(let i = 0; i < this._header.bitsPerSample.data - 1; ++i){
                this._maxAmplitude |= 1 << i;
            }
            this._twoComplement = Math.pow(2, this._header.bitsPerSample.data);
            this.phase = "body";
        }
    }
    _write(data, encoding, callback){
        for(let i = 0; i < data.length; ++i){
            if(this.phase == "body"){
                this._readBody(data[i]);
            }
            else{
                this._readHeader(data[i]);
            }
        }
        callback(null, data);
    }
    _final(callback){
        debugger;
        if(this._resultIdx < this._resolution){
            this.results[this._resultIdx] = 0;  
        }
        callback();
    }
    _readBody(octet){
        if(this._octetNum === undefined){
            this._octetNum = 0;
        }
        else{
            this._octetNum += 1;
        }
        this._sample |= octet <<  8 * this._byteNumber;
        if(++this._byteNumber == this._header.blockAlign.data / this._header.numChannels.data){
            if(this._sample > this._maxAmplitude){
                this._sample = -1 *(this._twoComplement - this._sample);
            }
            this._windowMax = Math.max(this._windowMax, this._sample);
            this._byteNumber = 0;
            this._sample = 0;
            if(++this._sampleNumber == this._samplesPerWindow){
                this._windows[this._windowIdx] = this._windowMax;
                this._windowMax = 0;
                this._sampleNumber = 0;
                if(++this._windowIdx == this._windowResolution){
                    this.results[this._resultIdx++] = this._averageSubWindows();
                    this._windowIdx = 0;
                }
            }
        }
    }

    _averageSubWindows(){
        return this._windows.reduce((accum, el)=> accum + el) /
            this._windowResolution / this._maxAmplitude;
    }
}


