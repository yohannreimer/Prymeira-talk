import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { canPerform } from '../access/roles.js';

const paramsSchema = z.object({ listId: z.string().uuid() });
const memberParamsSchema = paramsSchema.extend({ contactId: z.string().uuid() });
const nameSchema = z.object({ name: z.string().trim().min(1).max(120) });
const addMembersSchema = z.object({ contactIds: z.array(z.string().uuid()).min(1).max(5000) });
const MAX_MEMBERS = 5000;

function isPrismaError(error: unknown, code: string) {
  return !!error && typeof error === 'object' && 'code' in error && error.code === code;
}

export const broadcastListsRoutes: FastifyPluginAsync = async (app) => {
  const requireManage = (role: Parameters<typeof canPerform>[0]) => canPerform(role, 'campaign.manage');

  app.get('/broadcast-lists', async (request) => {
    const lists = await app.prisma.broadcastList.findMany({ where: { workspaceId: request.talk.workspaceId },
      include: { _count: { select: { members: true } } }, orderBy: { updatedAt: 'desc' } });
    return lists.map((list) => ({ id: list.id, name: list.name, memberCount: list._count.members,
      createdAt: list.createdAt.toISOString(), updatedAt: list.updatedAt.toISOString() }));
  });

  app.post('/broadcast-lists', async (request, reply) => {
    if (!requireManage(request.talk.role)) return reply.code(403).send({ error: 'Sem permissão para gerenciar listas.' });
    const body = nameSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'Informe um nome para a lista.' });
    try {
      const list = await app.prisma.broadcastList.create({ data: { workspaceId: request.talk.workspaceId, name: body.data.name } });
      return reply.code(201).send({ id: list.id, name: list.name, memberCount: 0,
        createdAt: list.createdAt.toISOString(), updatedAt: list.updatedAt.toISOString() });
    } catch (error) {
      if (isPrismaError(error, 'P2002')) return reply.code(409).send({ error: 'Já existe uma lista com esse nome.' });
      throw error;
    }
  });

  app.get('/broadcast-lists/:listId', async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Lista inválida.' });
    const list = await app.prisma.broadcastList.findFirst({ where: { workspaceId: request.talk.workspaceId, id: params.data.listId },
      include: { members: { include: { contact: { select: { id: true, name: true, phone: true, avatarUrl: true } } },
        orderBy: { createdAt: 'asc' } } } });
    if (!list) return reply.code(404).send({ error: 'Lista não encontrada.' });
    return { id: list.id, name: list.name, memberCount: list.members.length,
      contacts: list.members.map((member) => ({ id: member.contact.id, name: member.contact.name,
        phone: member.contact.phone, avatarUrl: member.contact.avatarUrl })),
      createdAt: list.createdAt.toISOString(), updatedAt: list.updatedAt.toISOString() };
  });

  app.patch('/broadcast-lists/:listId', async (request, reply) => {
    if (!requireManage(request.talk.role)) return reply.code(403).send({ error: 'Sem permissão para gerenciar listas.' });
    const params = paramsSchema.safeParse(request.params);
    const body = nameSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: 'Revise o nome da lista.' });
    try {
      const list = await app.prisma.broadcastList.update({ where: { workspaceId_id: {
        workspaceId: request.talk.workspaceId, id: params.data.listId } }, data: { name: body.data.name },
        include: { _count: { select: { members: true } } } });
      return { id: list.id, name: list.name, memberCount: list._count.members,
        createdAt: list.createdAt.toISOString(), updatedAt: list.updatedAt.toISOString() };
    } catch (error) {
      if (isPrismaError(error, 'P2002')) return reply.code(409).send({ error: 'Já existe uma lista com esse nome.' });
      if (isPrismaError(error, 'P2025')) return reply.code(404).send({ error: 'Lista não encontrada.' });
      throw error;
    }
  });

  app.post('/broadcast-lists/:listId/members', async (request, reply) => {
    if (!requireManage(request.talk.role)) return reply.code(403).send({ error: 'Sem permissão para gerenciar listas.' });
    const params = paramsSchema.safeParse(request.params);
    const body = addMembersSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: 'Seleção inválida.' });
    const workspaceId = request.talk.workspaceId;
    const list = await app.prisma.broadcastList.findFirst({ where: { workspaceId, id: params.data.listId }, select: { id: true } });
    if (!list) return reply.code(404).send({ error: 'Lista não encontrada.' });
    const ids = [...new Set(body.data.contactIds)];
    const [contacts, existing, count] = await Promise.all([
      app.prisma.contact.findMany({ where: { workspaceId, id: { in: ids } }, select: { id: true } }),
      app.prisma.broadcastListMember.findMany({ where: { workspaceId, listId: list.id, contactId: { in: ids } }, select: { contactId: true } }),
      app.prisma.broadcastListMember.count({ where: { workspaceId, listId: list.id } })
    ]);
    if (contacts.length !== ids.length) return reply.code(404).send({ error: 'Um contato não foi encontrado.' });
    if (count + ids.length - existing.length > MAX_MEMBERS) return reply.code(409).send({ error: 'A lista aceita até 5.000 contatos.' });
    await app.prisma.broadcastListMember.createMany({ data: ids.map((contactId) => ({ workspaceId, listId: list.id, contactId })), skipDuplicates: true });
    await app.prisma.broadcastList.update({ where: { workspaceId_id: { workspaceId, id: list.id } }, data: { updatedAt: new Date() } });
    return reply.code(204).send();
  });

  app.delete('/broadcast-lists/:listId/members/:contactId', async (request, reply) => {
    if (!requireManage(request.talk.role)) return reply.code(403).send({ error: 'Sem permissão para gerenciar listas.' });
    const params = memberParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Contato inválido.' });
    const workspaceId = request.talk.workspaceId;
    const list = await app.prisma.broadcastList.findFirst({ where: { workspaceId, id: params.data.listId }, select: { id: true } });
    if (!list) return reply.code(404).send({ error: 'Lista não encontrada.' });
    await app.prisma.broadcastListMember.deleteMany({ where: { workspaceId, listId: list.id, contactId: params.data.contactId } });
    await app.prisma.broadcastList.update({ where: { workspaceId_id: { workspaceId, id: list.id } }, data: { updatedAt: new Date() } });
    return reply.code(204).send();
  });
};
