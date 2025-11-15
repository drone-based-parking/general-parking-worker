import { Hono, Context, Next } from "hono";
import { cors } from "hono/cors";
import { handleRest } from './rest';
import type { R2Bucket } from '@cloudflare/workers-types';

export interface Env {
    DB: D1Database;
    PARKING_BUCKET: R2Bucket;
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
            const key = 'test/hello.txt';
            const body = 'Hello from R2!';

            // Write object to R2
            await c.env.PARKING_BUCKET.put(key, body);

            // Read it back
            const obj = await c.env.PARKING_BUCKET.get(key);
            const text = obj ? await obj.text() : null;

            return c.json({
                key,
                value_read_back: text,
            });
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
        
        return app.fetch(request, env, ctx);
    }
} satisfies ExportedHandler<Env>;
