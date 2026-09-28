import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { broadcastListsRoutes } from './broadcast-lists.routes.js';

const listId = '00000000-0000-4000-8000-000000000201';
const contactId = '00000000-0000-4000-8000-000000000202';
const date = new Date('2026-09-28T19:15:00Z');
const list = { id: listId, workspaceId: 'workspace-a', name: 'Clientes Villefer', createdAt: date, updatedAt: date,
  _count: { members: 1 } };

function setup(options: { contacts?: Array<{ id: string }>; role?: 'owner' | 'agent' } = {}) {
  const prisma = {
    broadcastList: {
      findMany: vi.fn().mockResolvedValue([list]),
      findFirst: vi.fn().mockResolvedValue({ id: listId }),
      create: vi.fn().mockResolvedValue({ ...list, _count: undefined }),
      update: vi.fn().mockResolvedValue(list)
    },
    broadcastListMember: {
      findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0),
      createMany: vi.fn().mockResolvedValue({ count: 1 }), deleteMany: vi.fn().mockResolvedValue({ count: 1 })
    },
    contact: { findMany: vi.fn().mockResolvedValue(options.contacts ?? [{ id: contactId }]) }
  };
  const app = Fastify({ logger: false });
  app.decorate('prisma', prisma as never);
  app.addHook('preHandler', async (request) => { request.talk = { workspaceId: 'workspace-a', role: options.role ?? 'owner' }; });
  return { app, prisma };
}

describe('saved broadcast lists', () => {
  it('lists only lists in the current workspace', async () => {
    const { app, prisma } = setup();
    await app.register(broadcastListsRoutes);
    try {
      const response = await app.inject({ method: 'GET', url: '/broadcast-lists' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual([expect.objectContaining({ name: 'Clientes Villefer', memberCount: 1 })]);
      expect(prisma.broadcastList.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { workspaceId: 'workspace-a' } }));
    } finally { await app.close(); }
  });

  it('adds only tenant-owned contacts to a saved list', async () => {
    const { app, prisma } = setup();
    await app.register(broadcastListsRoutes);
    try {
      const response = await app.inject({ method: 'POST', url: `/broadcast-lists/${listId}/members`, payload: { contactIds: [contactId] } });
      expect(response.statusCode).toBe(204);
      expect(prisma.contact.findMany).toHaveBeenCalledWith({ where: { workspaceId: 'workspace-a', id: { in: [contactId] } }, select: { id: true } });
      expect(prisma.broadcastListMember.createMany).toHaveBeenCalledWith({ data: [{ workspaceId: 'workspace-a', listId, contactId }], skipDuplicates: true });
    } finally { await app.close(); }
  });

  it('rejects a contact from another workspace and cannot add it', async () => {
    const { app, prisma } = setup({ contacts: [] });
    await app.register(broadcastListsRoutes);
    try {
      const response = await app.inject({ method: 'POST', url: `/broadcast-lists/${listId}/members`, payload: { contactIds: [contactId] } });
      expect(response.statusCode).toBe(404);
      expect(prisma.broadcastListMember.createMany).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  it('limits list edits to campaign managers', async () => {
    const { app, prisma } = setup({ role: 'agent' });
    await app.register(broadcastListsRoutes);
    try {
      const response = await app.inject({ method: 'POST', url: '/broadcast-lists', payload: { name: 'Outra lista' } });
      expect(response.statusCode).toBe(403);
      expect(prisma.broadcastList.create).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
});
