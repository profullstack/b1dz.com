/** Maps logical collection names → physical Postgres tables + primary key. */
export const COLLECTION_TABLES: Record<string, { table: string; pk: string }> = {
  opportunities: { table: 'opportunities', pk: 'id' },
  alerts: { table: 'alerts', pk: 'id' },
  'source-state': { table: 'source_state', pk: 'source_id' },
};
