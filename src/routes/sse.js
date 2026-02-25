import { Router } from 'express';

export function criarRotasSSE(broadcaster) {
  const router = Router();

  router.get('/', (req, res) => {
    res.setHeader('Content-Type',  'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection',    'keep-alive');
    res.flushHeaders();

    // Heartbeat a cada 25s para evitar timeout de proxy/balanceador
    const heartbeat = setInterval(() => res.write(':ping\n\n'), 25_000);

    res.write('event: connected\ndata: {}\n\n');
    broadcaster.clients.add(res);

    req.on('close', () => {
      clearInterval(heartbeat);
      broadcaster.clients.delete(res);
    });
  });

  return router;
}
