const { Pool } = require("pg");
const pool = new Pool({ 
  connectionString: process.env.DATABASE_URL 
});

async function run() {
  try {
    const res = await pool.query(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns 
      WHERE table_name = 'file_index'
      ORDER BY ordinal_position
    `);
    console.log("Columns:", res.rows.map(r => `${r.column_name}(${r.data_type})`).join(", "));
    
    const sample = await pool.query(`SELECT * FROM file_index LIMIT 1`);
    if (sample.rows[0]) {
      const row = sample.rows[0];
      console.log("Sample keys:", Object.keys(row).join(", "));
      console.log("metadata type:", typeof row.metadata);
      if (row.metadata) console.log("metadata keys:", Object.keys(row.metadata));
    }
  } catch(err) {
    console.error("Error:", err.message);
  } finally {
    await pool.end();
  }
}

run();
