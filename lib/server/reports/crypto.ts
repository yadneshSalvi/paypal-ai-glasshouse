import {PaymentSecrets} from '@/packages/payments/security';
import {HttpError} from '../errors';
export class ReportSecrets {
  private cipher:PaymentSecrets;
  constructor(key:string){this.cipher=new PaymentSecrets(key);}
  private identity(tenantId:string,kind:string,id:string){return JSON.stringify(['glasshouse-report-v1',tenantId,kind,id]);}
  seal(tenantId:string,kind:string,id:string,value:unknown){return this.cipher.seal(value,this.identity(tenantId,kind,id));}
  open<T>(tenantId:string,kind:string,id:string,value:string):T{try{return this.cipher.open<T>(value,this.identity(tenantId,kind,id));}catch{throw new HttpError(409,'REPORT_UNVERIFIED','This private report could not be verified. Its original encrypted edition is preserved.');}}
}
