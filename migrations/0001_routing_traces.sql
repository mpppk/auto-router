-- routing trace (#7)。raw Authorization / message 本文は保存しない。
CREATE TABLE routing_traces (
	id TEXT PRIMARY KEY,
	-- caller の OpenRouter API key の HMAC fingerprint (raw key は保存しない)
	owner TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL,
	-- 0: summary trace, 1: Auto-Router-Debug による詳細 trace
	debug INTEGER NOT NULL,
	trace TEXT NOT NULL
);

CREATE INDEX idx_routing_traces_expires_at ON routing_traces (expires_at);
