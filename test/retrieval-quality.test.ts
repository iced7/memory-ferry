import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { StateStore } from '../src/state.js';
import { Vault } from '../src/vault.js';
import { unavailableEmbedding } from './helpers.js';

test('Chinese recall requires meaningful overlap and context honors project boundaries', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(),'memory-ferry-recall-'));
  const vault = await Vault.init(path.join(root,'vault'),'Recall',new StateStore(path.join(root,'state')),unavailableEmbedding);
  await vault.remember({content:'Memory Ferry 在本机开发，保存跨 Agent 记忆',scope:'project',scopeId:'memory-ferry'});
  await vault.remember({content:'NOTE4 本机固件已经更新',scope:'project',scopeId:'note4'});
  await vault.remember({content:'回答偏好简洁中文',kind:'preference'});
  assert.equal((await vault.search('Memory Ferry 本机开发',10,{semantic:false})).length,1);
  assert.equal((await vault.search('中文偏好',10,{semantic:false})).length,1);
  const context = await vault.context('',10,{semantic:false,projectId:'memory-ferry'});
  assert.match(context,/Memory Ferry/);
  assert.match(context,/简洁中文/);
  assert.doesNotMatch(context,/NOTE4/);
  assert.match(await vault.context('',10,{semantic:false,projectId:'memory-ferry',allScopes:true}),/NOTE4/);
});

test('duplicate discovery is scope-aware and never deletes memories', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(),'memory-ferry-duplicates-'));
  const vault = await Vault.init(path.join(root,'vault'),'Duplicates',new StateStore(path.join(root,'state')),unavailableEmbedding);
  await vault.remember({content:'Use npm',scope:'project',scopeId:'one'});
  await vault.remember({content:'Use  NPM',scope:'project',scopeId:'one'});
  await vault.remember({content:'Use npm',scope:'project',scopeId:'two'});
  const groups = await vault.duplicates();
  assert.equal(groups.length,1);
  assert.equal(groups[0].ids.length,2);
  assert.equal((await vault.list()).length,3);
  assert.equal((await vault.context('',10,{projectId:'one',semantic:false})).split('\n').length,1);
});
