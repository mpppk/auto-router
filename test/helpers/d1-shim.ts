import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";

/** bun:sqlite 上で trace store が使う D1 API の最小部分を再現する。 */
export const createD1Shim = (): D1Database => {
	const db = new Database(":memory:");
	db.exec(readFileSync("migrations/0001_routing_traces.sql", "utf8"));
	const prepare = (sql: string) => {
		let params: (string | number | null)[] = [];
		const statement = {
			bind(...values: (string | number | null)[]) {
				params = values;
				return statement;
			},
			async run() {
				db.query(sql).run(...params);
				return { success: true };
			},
			async first<T>() {
				return (db.query(sql).get(...params) as T | null) ?? null;
			},
		};
		return statement;
	};
	return { prepare } as unknown as D1Database;
};
