import type {Metadata,Viewport} from 'next';
import './globals.css';
import './reports.css';
export const metadata:Metadata={title:'Glasshouse — see the whole story',description:'A living incident room for commerce. Follow the evidence, rewind the business and recover with intention.'};
export const viewport:Viewport={width:'device-width',initialScale:1,themeColor:'#0b151b'};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="en"><body>{children}</body></html>;}
