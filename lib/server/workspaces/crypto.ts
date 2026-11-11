import {createHash} from 'node:crypto';
import {PaymentSecrets} from '@/packages/payments/security';
import {HttpError} from '../errors';

export const tokenHash=(token:string)=>createHash('sha256').update(token).digest('hex');
export class WorkspaceSecrets {
  private cipher:PaymentSecrets;
  constructor(key:string){this.cipher=new PaymentSecrets(key);}
  private identity(kind:string,id:string){return JSON.stringify(['glasshouse-workspace-v1',kind,id]);}
  seal(kind:string,id:string,value:unknown){return this.cipher.seal(value,this.identity(kind,id));}
  open<T>(kind:string,id:string,value:string):T{
    try{return this.cipher.open<T>(value,this.identity(kind,id));}
    catch{throw new HttpError(409,'WORKSPACE_RECORD_UNVERIFIED','This private access record could not be verified. Its original is preserved.');}
  }
}
