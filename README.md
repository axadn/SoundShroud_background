# SoundShroud_background

This server will work in the background, fetching audio conversion tasks from a job queue for my SoundShroud site.
This will allow me to have seperate machine types on the back end. One for serving up html/css/json, one for the database, and one for doing the audio conversion taks.


We'll take advantage of Node.js streams to avoid ever holding the whole file in memory or writing anything to the disk. A file will be streamed in from S3 storage, processed on the fly, and streamed back to S3 storage.
