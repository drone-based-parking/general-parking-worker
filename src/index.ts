import { Hono, Context, Next } from "hono";
import { cors } from "hono/cors";
import { handleRest } from './rest';

export interface Env {
    DB: D1Database;
    r2_parking: R2Bucket;
    SECRET: SecretsStoreSecret;
}

// # List all users
// GET /rest/users

// # Get filtered and sorted users
// GET /rest/users?age=25&sort_by=name&order=desc

// # Get paginated results
// GET /rest/users?limit=10&offset=20

// # Create a new user
// POST /rest/users
// { "name": "John", "age": 30 }

// # Update a user
// PATCH /rest/users/123
// { "age": 31 }

// # Delete a user
// DELETE /rest/users/123

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        const app = new Hono<{ Bindings: Env }>();
        // Apply CORS to all routes
        app.use('*', async (c, next) => {
            return cors()(c, next);
        })
        
        app.get('/api/health', (c) => {
            return c.json({ status: 'ok' });
        });
        
        app.get('/api/r2-test', async (c) => {
          try {
            const key = 'test/hello.txt';
            const body = 'Hello from R2 via Worker!';
        
            // Use the binding name from the dashboard: r2_parking
            await c.env.r2_parking.put(key, body);
        
            const obj = await c.env.r2_parking.get(key);
            const text = obj ? await obj.text() : null;
        
            return c.json({
              key,
              value_read_back: text,
            });
          } catch (err: any) {
            console.error(err);
            return c.json(
              { error: err?.message ?? String(err) },
              500
            );
          }
        });
        
        // Secret Store key value that we have set
        const secret = await env.SECRET.get();

        // Authentication middleware that verifies the Authorization header
        // is sent in on each request and matches the value of our Secret key.
        // If a match is not found we return a 401 and prevent further access.
        const authMiddleware = async (c: Context, next: Next) => {
            const authHeader = c.req.header('Authorization');
            if (!authHeader) {
                return c.json({ error: 'Unauthorized' }, 401);
            }

            const token = authHeader.startsWith('Bearer ')
                ? authHeader.substring(7)
                : authHeader;

            if (token !== secret) {
                return c.json({ error: 'Unauthorized' }, 401);
            }

            return next();
        };

        // CRUD REST endpoints made available to all of our tables
        app.all('/rest/*', authMiddleware, handleRest);

        // Execute a raw SQL statement with parameters with this route
        app.post('/query', authMiddleware, async (c) => {
            try {
                const body = await c.req.json();
                const { query, params } = body;

                if (!query) {
                    return c.json({ error: 'Query is required' }, 400);
                }

                // Execute the query against D1 database
                const results = await env.DB.prepare(query)
                    .bind(...(params || []))
                    .all();

                return c.json(results);
            } catch (error: any) {
                return c.json({ error: error.message }, 500);
            }
        });
        
        app.get('/api/lot', async (c) => {
            const { results } = await env.DB
                .prepare('SELECT * FROM lot')
                .all();

            return c.json(results);
        });

        app.get('/api/space', async (c) => {
            const { results } = await env.DB
                .prepare('SELECT * FROM space')
                .all();

            return c.json(results);
        });
        
        app.get('/api/get-frame/:key', async (c) => {
          try {
            const key = decodeURIComponent(c.req.param('key'));
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
            // Auto-detect content type if not provided
            let contentType = c.req.header('content-type') || 'application/octet-stream';
            
            // Handle multipart/form-data for easier browser uploads
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
                url: `/api/get-frame/${encodeURIComponent(key)}`,
              });
            }
            
            // Handle raw binary upload
            const url = new URL(c.req.url);
            const filename = url.searchParams.get('filename') || `frame-${Date.now()}`;
            
            // Try to infer content type from filename if generic
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
    
        
        return app.fetch(request, env, ctx);
    }
} satisfies ExportedHandler<Env>;
