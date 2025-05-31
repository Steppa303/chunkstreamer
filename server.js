
const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os'); // Korrigiert: require('os')
const cors = require('cors'); // CORS-Middleware importieren

const app = express();
// EvenNode (und andere PaaS) setzen die PORT Umgebungsvariable.
// Fallback auf 3000 für lokale Entwicklung.
const port = process.env.PORT || 3000;

// --- Konfiguration ---
const DEFAULT_AUDIO_PARAMS = {
    sampleRate: 48000,
    numChannels: 2,
    bitsPerSample: 16,
};
const TEMP_AUDIO_FILE_NAME = 'chromecast_audio_stream.wav';
const TEMP_AUDIO_FILE = path.join(os.tmpdir(), TEMP_AUDIO_FILE_NAME);
let headerWritten = false;
let totalDataBytesWritten = 0; // Zählt nur die reinen Audiodaten nach dem Header

// --- Middleware ---
// CORS für alle Routen aktivieren (oder spezifischer, falls nötig)
app.use(cors());

// Middleware, um rohe POST-Daten zu verarbeiten
app.use('/upload-chunk', express.raw({
    type: 'application/octet-stream',
    limit: '10mb'
}));

// Funktion zum Schreiben des WAV-Headers
function writeWavHeader(filePath, params) {
    const buffer = Buffer.alloc(44);
    const byteRate = params.sampleRate * params.numChannels * (params.bitsPerSample / 8);
    const blockAlign = params.numChannels * (params.bitsPerSample / 8);
    const MAX_UINT32 = 0xFFFFFFFF; // Use a very large value for unknown size

    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(MAX_UINT32, 4); // FileSize - 8 (unknown, so max)
    buffer.write('WAVE', 8);
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16); // Sub-chunk 1 Size (PCM = 16)
    buffer.writeUInt16LE(1, 20);  // Audio Format (PCM = 1)
    buffer.writeUInt16LE(params.numChannels, 22);
    buffer.writeUInt32LE(params.sampleRate, 24);
    buffer.writeUInt32LE(byteRate, 28);
    buffer.writeUInt16LE(blockAlign, 32);
    buffer.writeUInt16LE(params.bitsPerSample, 34);
    buffer.write('data', 36);
    buffer.writeUInt32LE(MAX_UINT32, 40); // Sub-chunk 2 Size (data size, unknown, so max)

    fs.writeFileSync(filePath, buffer);
    console.log(`WAV Header (streaming-style) geschrieben nach: ${filePath} mit Parametern: `, params);
    return buffer.length;
}

// Endpunkt zum Empfangen von Audio-Chunks
app.post('/upload-chunk', (req, res) => {
    if (!req.body || req.body.length === 0) {
        return res.status(400).send('Keine Daten im Chunk.');
    }

    try {
        if (!headerWritten) {
            // Use query parameters for the first chunk if available, otherwise use defaults
            const querySampleRate = req.query.sampleRate ? parseInt(req.query.sampleRate, 10) : DEFAULT_AUDIO_PARAMS.sampleRate;
            const queryNumChannels = req.query.numChannels ? parseInt(req.query.numChannels, 10) : DEFAULT_AUDIO_PARAMS.numChannels;
            const queryBitsPerSample = req.query.bitsPerSample ? parseInt(req.query.bitsPerSample, 10) : DEFAULT_AUDIO_PARAMS.bitsPerSample;

            const currentAudioParams = {
                sampleRate: querySampleRate,
                numChannels: queryNumChannels,
                bitsPerSample: queryBitsPerSample,
            };

            if (fs.existsSync(TEMP_AUDIO_FILE)) {
                fs.unlinkSync(TEMP_AUDIO_FILE);
                console.log('Alte temporäre Datei gelöscht vor Header-Schreiben.');
            }
            // Use currentAudioParams (potentially from query) to write the header
            writeWavHeader(TEMP_AUDIO_FILE, currentAudioParams);
            totalDataBytesWritten = 0;
            headerWritten = true;
        }

        fs.appendFileSync(TEMP_AUDIO_FILE, req.body);
        totalDataBytesWritten += req.body.length;
        // console.log(`Chunk empfangen (${req.body.length} Bytes). Gesamt-Audiodaten: ${totalDataBytesWritten} Bytes.`);
        res.status(200).send('Chunk empfangen.');

    } catch (error) {
        console.error('Fehler beim Verarbeiten des Chunks:', error);
        res.status(500).send('Fehler beim Verarbeiten des Chunks.');
    }
});

// Endpunkt zum Streamen der Audio-Datei
app.get('/stream', (req, res) => {
    if (!fs.existsSync(TEMP_AUDIO_FILE)) {
        console.warn('/stream aufgerufen, aber Datei existiert nicht:', TEMP_AUDIO_FILE);
        return res.status(404).send('Audio-Stream noch nicht verfügbar oder zurückgesetzt.');
    }

    const stat = fs.statSync(TEMP_AUDIO_FILE);
    const fileSize = stat.size;

    const range = req.headers.range;

    if (range) {
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        let end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

        // Sicherstellen, dass 'end' nicht über die Dateigröße hinausgeht
        if (end >= fileSize) {
            end = fileSize - 1;
        }
        
        if (start >= fileSize || start > end) {
            res.status(416).send('Angeforderter Bereich nicht erfüllbar.');
            return;
        }

        const chunksize = (end - start) + 1;
        const file = fs.createReadStream(TEMP_AUDIO_FILE, { start, end });
        const head = {
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunksize,
            'Content-Type': 'audio/wav',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Pragma': 'no-cache',
            'Expires': '0'
        };

        res.writeHead(206, head);
        file.pipe(res);
    } else {
        // Für initiale Anfragen (ohne Range-Header) Content-Length weglassen,
        // damit Transfer-Encoding: chunked verwendet wird.
        const head = {
            // 'Content-Length': fileSize, // Entfernt!
            'Content-Type': 'audio/wav',
            'Accept-Ranges': 'bytes', // Wichtig, um anzuzeigen, dass Range-Requests unterstützt werden
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Pragma': 'no-cache',
            'Expires': '0'
        };
        res.writeHead(200, head);
        fs.createReadStream(TEMP_AUDIO_FILE).pipe(res);
    }
});

// Endpunkt zum Zurücksetzen/Löschen des Streams
app.post('/reset-stream', (req, res) => {
    if (fs.existsSync(TEMP_AUDIO_FILE)) {
        try {
            fs.unlinkSync(TEMP_AUDIO_FILE);
            console.log('Temporäre Audiodatei durch /reset-stream gelöscht.');
        } catch (err) {
            console.error('Fehler beim Löschen der temporären Datei via /reset-stream:', err);
        }
    }
    headerWritten = false;
    totalDataBytesWritten = 0;
    console.log('Audio-Stream zurückgesetzt.');
    res.status(200).send('Audio-Stream zurückgesetzt.');
});

// Einfacher Health-Check-Endpunkt
app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

// Server starten
const server = app.listen(port, () => {
    console.log(`Audio Streaming Service läuft auf Port ${port}`);
    console.log(`Temporäre Audiodatei wird in: ${os.tmpdir()} als ${TEMP_AUDIO_FILE_NAME} gespeichert`);
    // Initial cleanup
    if (fs.existsSync(TEMP_AUDIO_FILE)) {
        try {
            fs.unlinkSync(TEMP_AUDIO_FILE);
            console.log('Alte temporäre Datei beim Start gelöscht.');
        } catch (err) {
            console.error('Fehler beim Löschen der alten temporären Datei beim Start:', err);
        }
    }
});

// Graceful Shutdown
function gracefulShutdown() {
    console.log('Server wird heruntergefahren...');
    server.close(() => {
        console.log('HTTP-Server geschlossen.');
        if (fs.existsSync(TEMP_AUDIO_FILE)) {
            try {
                fs.unlinkSync(TEMP_AUDIO_FILE);
                console.log('Temporäre Audiodatei beim Herunterfahren gelöscht.');
            } catch (err) {
                console.error('Fehler beim Löschen der temporären Datei beim Herunterfahren:', err);
            }
        }
        process.exit(0);
    });
}

process.on('SIGINT', gracefulShutdown); // Ctrl+C
process.on('SIGTERM', gracefulShutdown); // Von PaaS gesendet
