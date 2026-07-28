import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import * as bcrypt from "bcrypt";
import { seedPrompts } from "./seed-prompts";

export async function seedDatabase(
  prisma: PrismaClient,
  env: NodeJS.ProcessEnv = process.env,
) {
  const adminUsername = env.ADMIN_USERNAME?.trim();
  const adminPassword = env.ADMIN_PASSWORD;

  if (Boolean(adminUsername) !== Boolean(adminPassword)) {
    throw new Error(
      "ADMIN_USERNAME and ADMIN_PASSWORD must be provided together",
    );
  }

  await seedPrompts(prisma);

  if (!adminUsername || !adminPassword) {
    console.warn(
      "Skipping admin seed: ADMIN_USERNAME and ADMIN_PASSWORD are not configured.",
    );
    console.log("Seeding complete!");
    return;
  }

  console.log("Seeding admin user...");

  const existingAdmin = await prisma.adminUser.findUnique({
    where: { username: adminUsername },
  });

  if (existingAdmin) {
    console.log(`Admin user already exists: ${adminUsername}`);
    console.log("Seeding complete!");
    return;
  }

  const passwordHash = await bcrypt.hash(adminPassword, 10);
  await prisma.adminUser.create({
    data: {
      username: adminUsername,
      passwordHash,
    },
  });
  console.log(`Created admin user: ${adminUsername}`);

  console.log("Seeding complete!");
}

async function main() {
  const prisma = new PrismaClient();

  try {
    await seedDatabase(prisma);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
