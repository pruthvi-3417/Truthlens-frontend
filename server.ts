import path from 'node:path';
import express, { type Request, type Response } from 'express';
import { createApiApp } from './server/app.ts';

async function startServer() {
  const { app } = createApiApp();

  if (process.env.NODE_ENV === 'production') {
    const distDir = path.resolve('frontend/dist');
    app.use(express.static(distDir));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  } else {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      configFile: path.resolve('frontend/vite.config.ts'),
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  const port = Number(process.env.PORT) || 3000;
  app.listen(port, '0.0.0.0', () => {
    console.log(`TruthLens server listening on http://0.0.0.0:${port}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start TruthLens server:', err);
  process.exit(1);
});
