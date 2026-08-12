import { ApiError } from './errors.js';
import type { HouseholdMember, HouseholdRole, Permission } from './types.js';

const rolePermissions: Record<HouseholdRole, ReadonlySet<Permission>> = {
  owner: new Set([
    'household:read', 'inventory:write', 'cooking:write', 'shopping:write', 'household:settings',
    'members:invite', 'members:remove', 'members:role', 'household:transfer', 'household:delete',
  ]),
  admin: new Set([
    'household:read', 'inventory:write', 'cooking:write', 'shopping:write', 'household:settings',
    'members:invite', 'members:remove', 'members:role',
  ]),
  member: new Set(['household:read', 'inventory:write', 'cooking:write', 'shopping:write']),
  viewer: new Set(['household:read']),
};

export function can(role: HouseholdRole, permission: Permission): boolean {
  return rolePermissions[role].has(permission);
}

export function requirePermission(member: HouseholdMember | undefined, permission: Permission): HouseholdMember {
  if (!member || member.status !== 'active') {
    throw new ApiError('HOUSEHOLD_FORBIDDEN', '无权访问这个家庭空间', 403);
  }
  if (!can(member.role, permission)) {
    throw new ApiError('HOUSEHOLD_FORBIDDEN', '当前家庭角色没有执行此操作的权限', 403, { permission });
  }
  return member;
}

export function canAssignRole(actor: HouseholdRole, target: HouseholdRole): boolean {
  if (actor === 'owner') return target !== 'owner';
  if (actor === 'admin') return target === 'member' || target === 'viewer';
  return false;
}

export const permissionsByRole = rolePermissions;
