import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ClientWorkspaceScope,WorkspaceContextError} from '../lib/workspace-context';

test('a response captured before a workspace switch cannot be applied to its replacement',()=>{
  const scope=new ClientWorkspaceScope();scope.admit('context-one','merchant-one');const ticket=scope.capture();scope.assert(ticket);
  scope.admit('context-two','merchant-two');assert.throws(()=>scope.assert(ticket),WorkspaceContextError);assert.equal(scope.capture().contextId,'context-two');
  scope.admit('context-one','merchant-one');assert.throws(()=>scope.assert(ticket),WorkspaceContextError,'Returning to an earlier room does not admit its old in-flight response.');
});
test('cross-tab selection holds the current view until the user explicitly admits a server context',()=>{
  const scope=new ClientWorkspaceScope();let notices=0;scope.subscribe(()=>{notices++;});scope.admit('one','room');const ticket=scope.capture();
  scope.observe('one');assert.equal(notices,1);scope.observe('two');assert.equal(scope.snapshot().held,true);assert.throws(()=>scope.capture(),WorkspaceContextError);assert.throws(()=>scope.assert(ticket),WorkspaceContextError);
  scope.observe('three');assert.equal(notices,2);assert.equal(scope.snapshot().contextId,'one');
  scope.admit('two','other-room');assert.equal(scope.snapshot().held,false);assert.equal(notices,3);
});
