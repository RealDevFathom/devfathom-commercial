// Offline-only explicit config. No dotenv or environment reads.
export default {
  schema: 'schema.prisma',
  datasource: { url: 'postgresql://offline:unused@127.0.0.1:1/offline' },
};
