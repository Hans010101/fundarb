CREATE TABLE IF NOT EXISTS platform_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO platform_settings (key, value, updated_at) VALUES
  ('mode', 'paper', unixepoch() * 1000),
  ('execution_emergency_stop', 'true', unixepoch() * 1000),
  ('order_submission_enabled', 'false', unixepoch() * 1000),
  ('live_enabled', 'false', unixepoch() * 1000),
  ('max_order_notional_usd', '2000', unixepoch() * 1000),
  ('max_effective_leverage', '2', unixepoch() * 1000);

CREATE TABLE IF NOT EXISTS exchange_connections (
  id TEXT PRIMARY KEY,
  exchange TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('testnet', 'live')),
  label TEXT NOT NULL,
  api_key_ciphertext TEXT NOT NULL,
  api_secret_ciphertext TEXT NOT NULL,
  passphrase_ciphertext TEXT,
  fingerprint TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  verification_status TEXT NOT NULL DEFAULT 'unverified',
  last_verified_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(exchange, environment, label)
);

CREATE INDEX IF NOT EXISTS idx_exchange_connections_enabled
  ON exchange_connections(enabled, exchange, environment);

CREATE TABLE IF NOT EXISTS hedge_intents (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  mode TEXT NOT NULL CHECK (mode IN ('paper', 'testnet', 'live')),
  symbol TEXT NOT NULL,
  long_connection_id TEXT NOT NULL,
  short_connection_id TEXT NOT NULL,
  long_quantity TEXT NOT NULL,
  short_quantity TEXT NOT NULL,
  notional_usd TEXT NOT NULL,
  hard_leg TEXT NOT NULL CHECK (hard_leg IN ('long', 'short')),
  state TEXT NOT NULL,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(long_connection_id) REFERENCES exchange_connections(id),
  FOREIGN KEY(short_connection_id) REFERENCES exchange_connections(id)
);

CREATE TABLE IF NOT EXISTS orders (
  client_order_id TEXT PRIMARY KEY,
  hedge_intent_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  leg TEXT NOT NULL CHECK (leg IN ('long', 'short')),
  action TEXT NOT NULL CHECK (action IN ('open', 'close', 'rollback')),
  side TEXT NOT NULL,
  quantity TEXT NOT NULL,
  status TEXT NOT NULL,
  exchange_order_id TEXT,
  raw_response TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(hedge_intent_id) REFERENCES hedge_intents(id),
  FOREIGN KEY(connection_id) REFERENCES exchange_connections(id)
);

CREATE INDEX IF NOT EXISTS idx_orders_hedge ON orders(hedge_intent_id, created_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  severity TEXT NOT NULL,
  actor TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);
