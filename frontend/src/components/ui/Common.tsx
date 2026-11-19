import type { ReactNode } from 'react';
import { AlertCircle, Inbox, LoaderCircle } from 'lucide-react';
export function StatusBadge({children,tone='neutral'}:{children:ReactNode;tone?:'neutral'|'blue'|'cyan'|'amber'|'red'}){return <span className={`status-badge ${tone}`}>{children}</span>}
export function StatCard({icon,label,value}:{icon:ReactNode;label:string;value:string|number}){return <div className="stat-card"><div className="stat-icon">{icon}</div><div><span>{label}</span><strong>{value}</strong></div></div>}
export function EmptyState({title,message,action}:{title:string;message:string;action?:ReactNode}){return <div className="empty-state"><Inbox/><h3>{title}</h3><p>{message}</p>{action}</div>}
export function LoadingState({message='Loading…'}:{message?:string}){return <div className="loading-state"><LoaderCircle className="spin"/><p>{message}</p></div>}
export function ErrorState({title='Unable to continue',message,action}:{title?:string;message:string;action?:ReactNode}){return <div className="error-state"><AlertCircle/><div><h3>{title}</h3><p>{message}</p></div>{action}</div>}
