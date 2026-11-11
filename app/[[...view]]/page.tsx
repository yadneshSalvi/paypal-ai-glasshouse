import {GlasshouseApp} from '@/components/glasshouse-app';
export default async function Page({params}:{params:Promise<{view?:string[]}>}){const {view}=await params;return <GlasshouseApp initialView={view?.[0]||'incident'}/>;}
