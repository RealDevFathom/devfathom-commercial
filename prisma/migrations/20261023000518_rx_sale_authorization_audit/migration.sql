-- An immutable, sale-scoped audit event records how each non-controlled Rx line
-- was authorized. The event is inserted in the same transaction as the line.
ALTER TYPE "PharmacySaleEventKind" ADD VALUE 'RX_AUTHORIZED';
