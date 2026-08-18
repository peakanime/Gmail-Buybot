import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const { Pool } = pg;

export const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
    max: 25,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
});

export const query = (text, params) => pool.query(text, params);

/**
 * Execute a sequence of SQL queries inside an isolated ACID database transaction.
 * @param {Function} callback (client) => Promise<any>
 */
export async function withTransaction(callback) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await callback(client);
        await client.query('COMMIT');
        return result;
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}