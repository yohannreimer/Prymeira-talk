// Isolated integration fixture: terminate after application commit, before consumer ACK.
import { PrismaClient } from '@prisma/client';
import { IngressApplicationService } from './application.ts';
import { IngressTransportConsumer } from './consumer.ts';
import { IngressJournal } from './journal.ts';
import { IngressPrivateStore } from './private-store.ts';
import { readIngressEnvironment } from './runtime.ts';
const config=readIngressEnvironment();
if(config.stage!=='isolated-1b') throw Error('isolated application fixture required');
const db=new PrismaClient({datasources:{db:{url:config.databaseUrl}}}),files=new IngressPrivateStore(config.privateRoot); await files.initialize();
const journal=new IngressJournal(db,files,config.workspaceAllowlist),service=new IngressApplicationService(journal);
await IngressTransportConsumer.start({url:config.amqpUrl,namespace:config.namespace,journal,publisher:()=>null,application:{async apply(id){await service.apply(id);process.exit(73);}}});
