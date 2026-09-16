import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { HermesMonitor } from '../src/main/trace-monitor/HermesMonitor';

test('native Hermes discovery stays lazy, pairs selected messages and distinguishes spawn from compression', async () => {
  const dir=await mkdtemp(path.join(os.tmpdir(),'hermes-monitor-'));
  const dbPath=path.join(dir,'state.db');
  const db=new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY,source TEXT,parent_session_id TEXT,model TEXT,cwd TEXT,started_at REAL,ended_at REAL,end_reason TEXT,input_tokens INTEGER,output_tokens INTEGER,tool_call_count INTEGER);
  CREATE TABLE messages(id INTEGER PRIMARY KEY,session_id TEXT,role TEXT,content TEXT,tool_call_id TEXT,tool_calls TEXT,tool_name TEXT,timestamp REAL,finish_reason TEXT,reasoning TEXT);`);
  const insertSession=db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?,?,?,?,?,?)');
  insertSession.run('main','desktop',null,'model','/tmp/project',100,200,'agent_close',1000,50,1);
  insertSession.run('child','subagent','main','model','/tmp/project',110,190,'agent_close',20,10,0);
  insertSession.run('continuation','desktop','main','model','/tmp/project',150,null,null,0,0,0);
  db.exec("ALTER TABLE sessions ADD COLUMN model_config TEXT; UPDATE sessions SET model_config='{\"_delegate_from\":\"main\"}' WHERE id='child'");
  const message=db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?,?,?,?)');
  message.run(1,'main','assistant','Working',null,JSON.stringify([{id:'call',type:'function',function:{name:'read',arguments:'{"path":"a"}'}}]),null,120,null,'Check files');
  message.run(2,'main','tool','done','call',null,'read',121,null,null);
  const monitor=new HermesMonitor({dbPath,pollMs:50});
  try {
    await monitor.start();
    assert.equal(monitor.snapshot().runs.length,2);
    assert.equal(monitor.snapshot().agents.length,0);
    assert.deepEqual(await monitor.getTrace('hermes:main'),[]);
    await monitor.loadRun('hermes:main');
    assert.equal(monitor.snapshot().agents.length,2);
    assert.equal(monitor.snapshot().edges.length,1);
    assert.equal(monitor.snapshot().agents.find(a=>a.id==='hermes:main')?.status,'idle');
    assert.equal(monitor.snapshot().agents.find(a=>a.id==='hermes:main')?.activity,'Interrupted');
    assert.equal(monitor.snapshot().agents.find(a=>a.id==='hermes:main')?.stats.inputTokens,1000);
    const trace=await monitor.getTrace('hermes:main');
    assert.equal(trace.find(e=>e.kind==='tool-call')?.callId,'call');
    assert.equal(trace.find(e=>e.kind==='tool-result')?.callId,'call');
    message.run(3,'main','assistant','New result',null,null,null,122,null,null);
    await new Promise(resolve=>setTimeout(resolve,130));
    assert.equal((await monitor.getTrace('hermes:main')).at(-1)?.text,'New result');
    for (let i=4;i<220;i++) message.run(i,'main','assistant',i===219?'x'.repeat(80000):`message ${i}`,null,null,null,122+i,null,null);
    await monitor.loadRun('hermes:main');
    db.exec('ALTER TABLE messages ADD COLUMN active INTEGER DEFAULT 1');
    db.prepare('INSERT INTO messages(id,session_id,role,content,timestamp,active) VALUES(?,?,?,?,?,?)').run(999,'main','assistant','rewound message',999,0);
    // A new connection detects schema evolution; production schema is fixed for a process.
    await monitor.stop();
    await monitor.start();
    await monitor.loadRun('hermes:main');
    const boundedTrace=await monitor.getTrace('hermes:main');
    assert.equal(boundedTrace.length,200);
    assert(boundedTrace.at(-1)!.text.length < 65600);
    assert.equal(monitor.snapshot().agents.find(a=>a.id==='hermes:main')?.stats.inputTokens,1000);
    await monitor.loadRun('hermes:continuation');
    assert.deepEqual(await monitor.getTrace('hermes:main'),[]);
    assert.equal(monitor.snapshot().agents.length,1);
    monitor.unloadRun();
    assert.equal(monitor.snapshot().agents.length,0);
  } finally { await monitor.stop(); db.close(); await rm(dir,{recursive:true,force:true}); }
});

test('missing Hermes database is an empty source and does not create a database', async () => {
  const dir=await mkdtemp(path.join(os.tmpdir(),'hermes-missing-'));
  const monitor=new HermesMonitor({dbPath:path.join(dir,'missing.db')});
  try { await monitor.start(); assert.deepEqual(monitor.snapshot().runs,[]); assert.deepEqual(monitor.snapshot().errors,[]); }
  finally { await monitor.stop(); await rm(dir,{recursive:true,force:true}); }
});

test('Hermes native counters add excluded cache tokens and retain per-model attribution', async () => {
  const dir=await mkdtemp(path.join(os.tmpdir(),'hermes-usage-'));
  const dbPath=path.join(dir,'state.db');
  const db=new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY,model TEXT,input_tokens INTEGER,output_tokens INTEGER,cache_read_tokens INTEGER,cache_write_tokens INTEGER);
    CREATE TABLE messages(id INTEGER PRIMARY KEY,session_id TEXT);
    CREATE TABLE session_model_usage(session_id TEXT,model TEXT,billing_provider TEXT,input_tokens INTEGER,output_tokens INTEGER,cache_read_tokens INTEGER,cache_write_tokens INTEGER);
    INSERT INTO sessions VALUES('run','gpt-5.6-luna',100,20,300,50);
    INSERT INTO session_model_usage VALUES('run','gpt-5.6-luna','openai-codex',100,20,300,50);`);
  const monitor=new HermesMonitor({dbPath});
  try {
    await monitor.start(); assert.equal(monitor.snapshot().agents.length,0);
    await monitor.loadRun('hermes:run');
    const a=monitor.snapshot().agents[0];
    assert.equal(a.stats.inputTokens,450);
    assert.deepEqual(a.tokenUsage,[{model:'gpt-5.6-luna',provider:'openai-codex',inputTokens:450,outputTokens:20,cacheReadTokens:300,cacheWriteTokens:50}]);
    a.tokenUsage![0].inputTokens=999;
    assert.equal(monitor.snapshot().agents[0].tokenUsage![0].inputTokens,450);
  } finally {await monitor.stop();db.close();await rm(dir,{recursive:true,force:true});}
});
