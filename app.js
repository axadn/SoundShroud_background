const fs = require('fs');
const http = require('http');
const wav = require('wav');
const {Pool} = require('pg');
const stream = require('stream');
const sox = require('sox-stream');
const PREVIEW_RESOLUTION = 64;

async function start(){
    const secrets = fs.readFileSync('./secrets.config','utf8');
    if(secrets){
        secrets.split('\n').forEach(line=>{
            const pair = line.split("="); 
            process.env[pair[0]] = pair[1];
        });
    }

    const pool = await new Pool();

    http.createServer(async (req, res)=>{
        let buffer = fs.readFileSync('sample.wav');
        generate_waveform(buffer);
        res.end("done");
    }).listen(3000);
    console.log('listening on port 3000');
}

function processAudio(trackId){

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
//A class that buffers bytes and generates a preview from them as they are streamed in
class PreviewGenerator extends stream.Transform{
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
        this._resolution = 200;
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
            this._samplesPerWindow = Math.ceil(
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
    _transform(data, encoding, callback){
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
function generate_waveform(){
    const convertToWav = sox({
        output:{
            rate: 44100,
            channels: 1,
            type: 'wav'
        }
    });
    const convertToMp3 = sox({
        output:{
            rate: 44100,
            channels: 2,
            type: 'mp3'
        }
    });
    const p= new PreviewGenerator();
    const httpResponse = fs.createReadStream('sample.wav')
    const output = fs.createWriteStream('sample.mp3');
    httpResponse
    .pipe(convertToWav)
    .pipe(p)

    httpResponse
    .pipe(convertToMp3)
    .pipe(output);

    p.on('finish', ()=>{
        debugger;
        console.log(p.results)
    });
}
generate_waveform();

