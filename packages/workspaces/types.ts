import type {Role} from '../domain/types';

export type OrganizationRole='owner'|'member';
export type WorkspaceStatus='active'|'archived';
export type InvitedRole=Exclude<Role,'judge'>;
export interface WorkspaceSummary {
  id:string;organizationId:string|null;organizationName:string|null;name:string;merchantName:string;
  description:string;status:WorkspaceStatus;version:number;role:Role;membershipVersion:number;
  source:'sample'|'existing';current:boolean;canManage:boolean;canGrantFinancialRoles:boolean;
}
export interface OrganizationSummary {id:string;name:string;version:number;role:OrganizationRole;workspaceCount:number}
export interface WorkspaceIdentity {
  personId:string;displayName:string;kind:'browser_capability';expiresAt:string;contextId:string;
  currentWorkspaceId:string;disclosure:string;
}
export interface WorkspaceDirectory {identity:WorkspaceIdentity;organizations:OrganizationSummary[];workspaces:WorkspaceSummary[]}
export interface WorkspaceMember {
  actorId:string;personId:string|null;displayName:string;role:Role;version:number;active:boolean;self:boolean;
}
export interface WorkspaceInvitation {
  id:string;workspaceId:string;role:InvitedRole;createdAt:string;expiresAt:string;
  state:'available'|'accepted'|'revoked'|'expired';createdBy:string;
}
export interface WorkspaceAdministration {
  workspace:WorkspaceSummary;members:WorkspaceMember[];invitations:WorkspaceInvitation[];
  organizationMembers:{personId:string;displayName:string;role:OrganizationRole;version:number;active:boolean;self:boolean}[];
  organizationVersion:number|null;canManageOrganization:boolean;
}
export interface WorkspaceBootstrap {identity:WorkspaceIdentity;workspace:WorkspaceSummary}
export interface WorkspaceSwitch {contextId:string;workspaceId:string}
export interface InvitationPreview {
  id:string;workspaceName:string;merchantName:string;organizationName:string;role:InvitedRole;
  expiresAt:string;accessDays:number;disclosure:string;
}
