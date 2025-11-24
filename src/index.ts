import { Hono, Context, Next } from "hono";
import { cors } from "hono/cors";
import { handleRest } from './rest';

export interface Env {
    DB: D1Database;
    r2_parking: R2Bucket;
    SECRET: SecretsStoreSecret; 
}

// Initialize Hono
const app = new Hono<{ Bindings: Env }>();

// Global Middleware
app.use('*', cors());

// Authentication Middleware
const authMiddleware = async (c: Context<{ Bindings: Env }>, next: Next) => {
    const authHeader = c.req.header('Authorization');
    if (!authHeader) {
        return c.json({ error: 'Unauthorized' }, 401);
    }

    const token = authHeader.startsWith('Bearer ')
        ? authHeader.substring(7)
        : authHeader;

    // Retrieve secret from the environment binding specific to this request
    const secret = await c.env.SECRET.get();

    if (token !== secret) {
        return c.json({ error: 'Unauthorized' }, 401);
    }

    return next();
};

// Public Routes
app.get('/api/health', (c) => {
    return c.json({ status: 'ok' });
});

app.get('/api/r2-test', async (c) => {
    try {
        const key = 'test/hello.txt';
        const body = 'Hello from R2 via Worker!';

        await c.env.r2_parking.put(key, body);

        const obj = await c.env.r2_parking.get(key);
        const text = obj ? await obj.text() : null;

        return c.json({
            key,
            value_read_back: text,
        });
    } catch (err: any) {
        console.error(err);
        return c.json({ error: err?.message ?? String(err) }, 500);
    }
});

// Protected Routes

// REST endpoints
app.all('/rest/*', authMiddleware, handleRest);

// Raw SQL Query
app.post('/query', authMiddleware, async (c) => {
    try {
        const body = await c.req.json();
        const { query, params } = body;

        if (!query) {
            return c.json({ error: 'Query is required' }, 400);
        }

        const results = await c.env.DB.prepare(query)
            .bind(...(params || []))
            .all();

        return c.json(results);
    } catch (error: any) {
        return c.json({ error: error.message }, 500);
    }
});

//Parking Specific Routes
app.get('/api/lot', async (c) => {
    const { results } = await c.env.DB
        .prepare('SELECT * FROM lot')
        .all();
    return c.json(results);
});

app.get('/api/space', async (c) => {
    const { results } = await c.env.DB
        .prepare('SELECT * FROM space')
        .all();
    return c.json(results);
});

app.get('/api/get-frame/*', async (c) => {
    try {
        const fullPath = c.req.path;
        const key = fullPath.replace('/api/get-frame/', '');

        const object = await c.env.r2_parking.get(key);

        if (!object) {
            return c.json({ error: 'Not found' }, 404);
        }

        const headers = new Headers();
        object.httpMetadata?.contentType && headers.set('Content-Type', object.httpMetadata.contentType);

        return new Response(object.body, { headers });
    } catch (err: any) {
        return c.json({ error: err?.message ?? String(err) }, 500);
    }
});

app.post('/api/upload-frame', async (c) => {
    try {
        let contentType = c.req.header('content-type') || 'application/octet-stream';

        // Multipart handling
        if (contentType.includes('multipart/form-data')) {
            const formData = await c.req.formData();
            const file = formData.get('file') as File;

            if (!file) {
                return c.json({ success: false, error: 'No file provided' }, 400);
            }

            const arrayBuffer = await file.arrayBuffer();
            const body = new Uint8Array(arrayBuffer);
            const filename = file.name || `frame-${Date.now()}`;
            contentType = file.type || 'application/octet-stream';

            const timestamp = Date.now();
            const key = `frames/${timestamp}-${filename}`;

            await c.env.r2_parking.put(key, body, {
                httpMetadata: { contentType },
            });

            return c.json({
                success: true,
                key,
                url: `/api/get-frame/${key}`,
            });
        }

        // Binary handling
        const url = new URL(c.req.url);
        const filename = url.searchParams.get('filename') || `frame-${Date.now()}`;

        if (contentType === 'application/octet-stream' && filename) {
            const ext = filename.split('.').pop()?.toLowerCase();
            const mimeTypes: Record<string, string> = {
                'jpg': 'image/jpeg',
                'jpeg': 'image/jpeg',
                'png': 'image/png',
                'gif': 'image/gif',
                'webp': 'image/webp',
            };
            contentType = mimeTypes[ext || ''] || contentType;
        }

        const arrayBuffer = await c.req.arrayBuffer();
        const body = new Uint8Array(arrayBuffer);

        const timestamp = Date.now();
        const key = `frames/${timestamp}-${filename}`;

        await c.env.r2_parking.put(key, body, {
            httpMetadata: { contentType },
        });

        return c.json({
            success: true,
            key,
            url: `/api/get-frame/${encodeURIComponent(key)}`,
        });
    } catch (err: any) {
        console.error(err);
        return c.json({ success: false, error: err?.message ?? String(err) }, 500);
    }
});

// Default Export
export default app;
