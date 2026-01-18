import { PrismaClient } from "@prisma/client";

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
    await prisma.prompt.create({
      data: {
        topic: prompt.topic,
        audioFileId: prompt.audioFileId,
        isActive: true,
      },
    });
    console.log(`Created prompt: ${prompt.topic}`);
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
