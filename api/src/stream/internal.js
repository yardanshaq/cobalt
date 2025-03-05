import { request } from "undici";
import { Readable } from "node:stream";
import { closeRequest, getHeaders, pipe } from "./shared.js";
import { handleHlsPlaylist, isHlsResponse } from "./internal-hls.js";

const CHUNK_SIZE = BigInt(8e6); // 8 MB
const min = (a, b) => a < b ? a : b;

async function* readChunks(streamInfo, size) {
    let read = 0n, chunksSinceTransplant = 0;
    while (read < size) {
        if (streamInfo.controller.signal.aborted) {
            throw new Error("controller aborted");
        }

        const chunk = await request(streamInfo.url, {
            headers: {
                ...getHeaders('youtube'),
                Range: `bytes=${read}-${read + CHUNK_SIZE}`
            },
            dispatcher: streamInfo.dispatcher,
            signal: streamInfo.controller.signal,
            maxRedirections: 4
        });

        if (chunk.statusCode === 403 && chunksSinceTransplant >= 3 && streamInfo.transplant) {
            chunksSinceTransplant = 0;
            try {
                await streamInfo.transplant(streamInfo.dispatcher);
                continue;
            } catch {}
        }

        chunksSinceTransplant++;

        const expected = min(CHUNK_SIZE, size - read);
        const received = BigInt(chunk.headers['content-length']);

        if (received < expected / 2n) {
            closeRequest(streamInfo.controller);
        }

        for await (const data of chunk.body) {
            yield data;
        }

        read += received;
    }
}

async function handleYoutubeStream(streamInfo, res) {
    const { signal } = streamInfo.controller;
    const cleanup = () => (res.end(), closeRequest(streamInfo.controller));

    try {
        const req = await fetch(streamInfo.url, {
            headers: getHeaders('youtube'),
            method: 'HEAD',
            dispatcher: streamInfo.dispatcher,
            signal
        });

        streamInfo.url = req.url;
        const size = BigInt(req.headers.get('content-length'));

        if (req.status !== 200 || !size) {
            return cleanup();
        }

        const generator = readChunks(streamInfo, size);

        const abortGenerator = () => {
            generator.return();
            signal.removeEventListener('abort', abortGenerator);
        }

        signal.addEventListener('abort', abortGenerator);

        const stream = Readable.from(generator);

        for (const headerName of ['content-type', 'content-length']) {
            const headerValue = req.headers.get(headerName);
            if (headerValue) res.setHeader(headerName, headerValue);
        }

        pipe(stream, res, cleanup);
    } catch {
        cleanup();
    }
}

async function handleGenericStream(streamInfo, res) {
    const { signal } = streamInfo.controller;
    const cleanup = () => res.end();

    try {
        const fileResponse = await request(streamInfo.url, {
            headers: {
                ...Object.fromEntries(streamInfo.headers),
                host: undefined
            },
            dispatcher: streamInfo.dispatcher,
            signal,
            maxRedirections: 16
        });

        res.status(fileResponse.statusCode);
        fileResponse.body.on('error', () => {});

        // bluesky's cdn responds with wrong content-type for the hls playlist,
        // so we enforce it here until they fix it
        const isHls = isHlsResponse(fileResponse)
                      || (streamInfo.service === "bsky" && streamInfo.url.endsWith('.m3u8'));

        for (const [ name, value ] of Object.entries(fileResponse.headers)) {
            if (!isHls || name.toLowerCase() !== 'content-length') {
                res.setHeader(name, value);
            }
        }

        if (fileResponse.statusCode < 200 || fileResponse.statusCode > 299) {
            return cleanup();
        }

        if (isHls) {
            await handleHlsPlaylist(streamInfo, fileResponse, res);
        } else {
            pipe(fileResponse.body, res, cleanup);
        }
    } catch {
        closeRequest(streamInfo.controller);
        cleanup();
    }
}

export function internalStream(streamInfo, res) {
    if (streamInfo.headers) {
        streamInfo.headers.delete('icy-metadata');
    }

    if (streamInfo.service === 'youtube' && !streamInfo.isHLS) {
        return handleYoutubeStream(streamInfo, res);
    }

    return handleGenericStream(streamInfo, res);
}
