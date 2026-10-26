import { prisma } from "../../lib/prisma";

const LEAD_PAGE_PERMISSIONS = [
  { action: "view", description: "All Leads" },
  { action: "create", description: "Create Lead" },
  { action: "assign", description: "Lead Pool" },
  { action: "view_closed", description: "Close Lost Lead" },
] as const;

/**
 * Keeps the lead page permissions in the catalog and, the first time
 * Close Lost Lead is added, copies it onto roles that already have All Leads.
 * Later role edits are left alone.
 */
export async function ensureLeadPagePermissions() {
  let closedIsNew = false;

  for (const item of LEAD_PAGE_PERMISSIONS) {
    const existing = await prisma.permission.findUnique({
      where: { resource_action: { resource: "lead", action: item.action } },
      select: { id: true },
    });
    if (item.action === "view_closed" && !existing) {
      closedIsNew = true;
    }
    await prisma.permission.upsert({
      where: { resource_action: { resource: "lead", action: item.action } },
      update: { module: "Lead Management", description: item.description },
      create: {
        module: "Lead Management",
        resource: "lead",
        action: item.action,
        description: item.description,
      },
    });
  }

  if (!closedIsNew) return;

  const [view, closed] = await Promise.all([
    prisma.permission.findUnique({
      where: { resource_action: { resource: "lead", action: "view" } },
      select: { id: true },
    }),
    prisma.permission.findUnique({
      where: { resource_action: { resource: "lead", action: "view_closed" } },
      select: { id: true },
    }),
  ]);
  if (!view || !closed) return;

  const roles = await prisma.role.findMany({
    where: { permissions: { some: { permissionId: view.id } } },
    select: { id: true },
  });
  if (!roles.length) return;

  await prisma.rolePermission.createMany({
    data: roles.map((role) => ({
      roleId: role.id,
      permissionId: closed.id,
    })),
    skipDuplicates: true,
  });
}

const PERMISSION_GRANT_ROLE_KEYS = ["admin", "ceo"] as const;

const ROLE_MANAGE_PERMISSIONS = [
  { resource: "permission", action: "configure" },
  { resource: "role", action: "edit" },
  { resource: "role", action: "delete" },
] as const;

/** Administrator and CEO can assign permissions, and edit or delete roles. */
export async function ensurePermissionGrantAccess() {
  const permissions = await Promise.all(
    ROLE_MANAGE_PERMISSIONS.map((item) =>
      prisma.permission.findUnique({
        where: {
          resource_action: { resource: item.resource, action: item.action },
        },
        select: { id: true, action: true, resource: true },
      }),
    ),
  );
  const found = permissions.filter(
    (item): item is { id: string; action: string; resource: string } =>
      Boolean(item),
  );
  if (!found.length) return;

  const grantRoles = await prisma.role.findMany({
    where: { key: { in: [...PERMISSION_GRANT_ROLE_KEYS] } },
    select: { id: true },
  });

  if (grantRoles.length) {
    await prisma.rolePermission.createMany({
      data: grantRoles.flatMap((role) =>
        found.map((permission) => ({
          roleId: role.id,
          permissionId: permission.id,
        })),
      ),
      skipDuplicates: true,
    });
  }

  const configure = found.find(
    (item) => item.resource === "permission" && item.action === "configure",
  );
  if (!configure) return;

  await prisma.rolePermission.deleteMany({
    where: {
      permissionId: configure.id,
      role: { key: { notIn: [...PERMISSION_GRANT_ROLE_KEYS] } },
    },
  });
}
