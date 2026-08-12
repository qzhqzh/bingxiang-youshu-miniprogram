import Fastify, { type FastifyRequest } from 'fastify';
import { ApiError } from './errors.js';
import { V2Service } from './service.js';
import type { HouseholdRole, SyncCommand } from './types.js';

function accessToken(request: FastifyRequest): string {
  const authorization = request.headers.authorization ?? '';
  const [scheme, token] = authorization.split(' ');
  if (scheme !== 'Bearer' || !token) throw new ApiError('UNAUTHENTICATED', '请先登录', 401);
  return token;
}

export function buildApp(service: V2Service) {
  const app = Fastify({ logger: false, requestIdHeader: 'x-request-id' });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) {
      return reply.status(error.statusCode).send({
        error: { code: error.code, message: error.message, details: error.details, requestId: request.id },
      });
    }
    request.log.error(error);
    return reply.status(500).send({
      error: { code: 'INTERNAL_ERROR', message: '服务暂时不可用', requestId: request.id },
    });
  });

  app.get('/healthz', async () => ({ ok: true, version: '2.0.0-alpha.0' }));

  app.post('/v2/auth/wechat', async (request) => {
    const body = request.body as { code?: string; deviceId?: string };
    return service.loginWechat(body?.code ?? '', body?.deviceId ?? '');
  });
  app.post('/v2/session/logout', async (request, reply) => {
    service.logout(accessToken(request));
    return reply.status(204).send();
  });
  app.get('/v2/me', async (request) => service.me(accessToken(request)));
  app.patch('/v2/me', async (request) => {
    const body = request.body as { displayName?: string };
    return service.updateProfile(accessToken(request), body?.displayName ?? '');
  });
  app.get('/v2/me/sessions', async (request) => service.listSessions(accessToken(request)));
  app.delete('/v2/me/sessions/:sessionId', async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    service.revokeSession(accessToken(request), sessionId);
    return reply.status(204).send();
  });

  app.get('/v2/households', async (request) => service.listHouseholds(accessToken(request)));
  app.post('/v2/households', async (request, reply) => {
    const body = request.body as { name?: string; timezone?: string };
    const created = service.createHousehold(accessToken(request), body?.name ?? '', body?.timezone);
    return reply.status(201).send(created);
  });
  app.get('/v2/households/:id', async (request) => {
    const { id } = request.params as { id: string };
    return service.bootstrap(accessToken(request), id).household;
  });
  app.patch('/v2/households/:id', async (request) => {
    const { id } = request.params as { id: string };
    return service.updateHousehold(accessToken(request), id, request.body as { name?: string; timezone?: string });
  });
  app.post('/v2/households/:id/invitations', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { role?: Exclude<HouseholdRole, 'owner'>; maxUses?: number };
    const result = service.createInvitation(accessToken(request), id, body?.role, body?.maxUses);
    return reply.status(201).send(result);
  });
  app.delete('/v2/households/:id/invitations/:invitationId', async (request, reply) => {
    const { id, invitationId } = request.params as { id: string; invitationId: string };
    service.revokeInvitation(accessToken(request), id, invitationId);
    return reply.status(204).send();
  });
  app.post('/v2/invitations/:token/accept', async (request) => {
    const { token } = request.params as { token: string };
    return service.acceptInvitation(accessToken(request), token);
  });
  app.patch('/v2/households/:id/members/:userId', async (request) => {
    const { id, userId } = request.params as { id: string; userId: string };
    const body = request.body as { role: Exclude<HouseholdRole, 'owner'> };
    return service.updateMemberRole(accessToken(request), id, userId, body.role);
  });
  app.delete('/v2/households/:id/members/:userId', async (request, reply) => {
    const { id, userId } = request.params as { id: string; userId: string };
    service.removeMember(accessToken(request), id, userId);
    return reply.status(204).send();
  });
  app.post('/v2/households/:id/transfer-ownership', async (request) => {
    const { id } = request.params as { id: string };
    const body = request.body as { userId: string };
    return service.transferOwnership(accessToken(request), id, body.userId);
  });

  app.get('/v2/bootstrap', async (request) => {
    const { householdId } = request.query as { householdId: string };
    return service.bootstrap(accessToken(request), householdId);
  });
  app.post('/v2/sync/push', async (request) => service.push(accessToken(request), request.body as SyncCommand));
  app.get('/v2/sync/pull', async (request) => {
    const query = request.query as { householdId: string; cursor?: string; limit?: string };
    return service.pull(accessToken(request), query.householdId, Number(query.cursor ?? 0), query.limit ? Number(query.limit) : undefined);
  });

  app.post('/v2/migrations/v1/prepare', async (request) => {
    const body = request.body as { householdId: string; importBatchId: string; source: string };
    return service.prepareV1Migration(accessToken(request), body.householdId, body.importBatchId, body.source);
  });
  app.post('/v2/migrations/v1/commit', async (request) => {
    const body = request.body as { householdId: string; importBatchId: string; source: string };
    return service.commitV1Migration(accessToken(request), body.householdId, body.importBatchId, body.source);
  });
  app.get('/v2/migrations/v1/:importBatchId', async (request) => {
    const { importBatchId } = request.params as { importBatchId: string };
    return service.migrationStatus(accessToken(request), importBatchId);
  });

  return app;
}
