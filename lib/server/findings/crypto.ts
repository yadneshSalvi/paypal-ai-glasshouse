import {PaymentSecrets,canonicalJson} from '@/packages/payments/security';
import {HttpError} from '../errors';
export class FindingSecrets {
  private readonly cipher:PaymentSecrets;
  constructor(key:string){this.cipher=new PaymentSecrets(key);}
  private identity(tenantId:string,kind:string,id:string){return canonicalJson({domain:'glasshouse-findings-v1',tenantId,kind,id});}
  seal(tenantId:string,kind:string,id:string,value:unknown){return this.cipher.seal(value,this.identity(tenantId,kind,id));}
  open<T>(tenantId:string,kind:string,id:string,value:string):T{try{return this.cipher.open<T>(value,this.identity(tenantId,kind,id));}catch{throw new HttpError(409,'FINDING_UNVERIFIED','This encrypted finding could not be verified. Its original record remains preserved.');}}
}
