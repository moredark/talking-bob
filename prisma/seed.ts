import { PrismaClient } from "@prisma/client";
import * as bcrypt from "bcrypt";

const prisma = new PrismaClient();

const prompts = [
  {
    topic: "Introduce yourself",
    audioFileId:
      "AwACAgIAAxkBAANMaW0zI-xVvZd8NIIf46YGR-6W0lMAAmKZAAI10mlLSngdMez2FLY4BA",
  },
  {
    topic: "Describe your daily routine",
    audioFileId:
      "AwACAgIAAxkBAANMaW0zI-xVvZd8NIIf46YGR-6W0lMAAmKZAAI10mlLSngdMez2FLY4BA",
  },
  {
    topic: "Talk about your hobbies",
    audioFileId:
      "AwACAgIAAxkBAANMaW0zI-xVvZd8NIIf46YGR-6W0lMAAmKZAAI10mlLSngdMez2FLY4BA",
  },
  {
    topic: "Describe your favorite place",
    audioFileId:
      "AwACAgIAAxkBAANMaW0zI-xVvZd8NIIf46YGR-6W0lMAAmKZAAI10mlLSngdMez2FLY4BA",
  },
  {
    topic: "What did you do last weekend?",
    audioFileId:
      "AwACAgIAAxkBAANMaW0zI-xVvZd8NIIf46YGR-6W0lMAAmKZAAI10mlLSngdMez2FLY4BA",
  },
];

async function main() {
  console.log("Seeding prompts...");

  for (const prompt of prompts) {
    const existing = await prisma.prompt.findFirst({
      where: { topic: prompt.topic },
    });

    if (!existing) {
      await prisma.prompt.create({
        data: {
          topic: prompt.topic,
          audioFileId: prompt.audioFileId,
          isActive: true,
        },
      });
      console.log(`Created prompt: ${prompt.topic}`);
    } else {
      console.log(`Prompt already exists: ${prompt.topic}`);
    }
  }

  console.log("Seeding admin user...");

  const adminUsername = process.env.ADMIN_USERNAME || "admin";
  const adminPassword = process.env.ADMIN_PASSWORD || "admin";

  const existingAdmin = await prisma.adminUser.findUnique({
    where: { username: adminUsername },
  });

  if (!existingAdmin) {
    const passwordHash = await bcrypt.hash(adminPassword, 10);
    await prisma.adminUser.create({
      data: {
        username: adminUsername,
        passwordHash,
      },
    });
    console.log(`Created admin user: ${adminUsername}`);
  } else {
    console.log(`Admin user already exists: ${adminUsername}`);
  }

  console.log("Seeding complete!");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
