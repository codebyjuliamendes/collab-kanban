
function queryAll(db, sql, params = []) {
  const stmt = db.prepare(sql);
  if (params.length) stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function queryOne(db, sql, params = []) {
  const rows = queryAll(db, sql, params);
  return rows[0] || null;
}

function runSql(db, sql, params = []) {
  db.run(sql, params);
  return { changes: db.getRowsModified() };
}

function runTransaction(db, callback) {
  db.run('BEGIN TRANSACTION');
  try {
    callback();
    db.run('COMMIT');
  } catch (error) {
    db.run('ROLLBACK');
    throw error;
  }
}

module.exports = { queryAll, queryOne, runSql, runTransaction };
