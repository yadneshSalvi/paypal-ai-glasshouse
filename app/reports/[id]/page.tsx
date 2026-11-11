import {ReportReader} from '@/components/report-reader';
export const metadata={title:'Saved edition · Glasshouse',robots:{index:false,follow:false},referrer:'no-referrer' as const};
export default async function ReportPage({params}:{params:Promise<{id:string}>}){const {id}=await params;return <ReportReader reportId={id}/>;}
