import {database} from '@/packages/db/client';
import {HttpError} from '../errors';
import {requireWorkspaceSchema} from './authority';
import {WorkspaceSecrets} from './crypto';
import {WorkspaceService} from './service';

export async function workspaceRuntime(){
  const db=await database();await requireWorkspaceSchema(db);
  const key=process.env.GLASSHOUSE_WORKSPACE_KEY||process.env.GLASSHOUSE_PAYMENT_KEY;
  if(!key)throw new HttpError(503,'WORKSPACE_STORAGE_KEY_REQUIRED','Private workspace access storage is not configured. Existing saved work is preserved.');
  return new WorkspaceService(db,new WorkspaceSecrets(key));
}
