import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const prompts = [
  // Personal Introduction & Background (1-10)
  { topic: "Introduce yourself", audioFileId: "" },
  { topic: "Tell me about your family", audioFileId: "" },
  { topic: "Where are you from? Describe your hometown", audioFileId: "" },
  { topic: "What do you do for a living?", audioFileId: "" },
  { topic: "Describe your best friend", audioFileId: "" },
  { topic: "What are your strengths and weaknesses?", audioFileId: "" },
  { topic: "Tell me about your childhood", audioFileId: "" },
  { topic: "What languages do you speak?", audioFileId: "" },
  { topic: "Describe your personality", audioFileId: "" },
  { topic: "What makes you unique?", audioFileId: "" },

  // Daily Life & Routines (11-20)
  { topic: "Describe your daily routine", audioFileId: "" },
  { topic: "What do you usually have for breakfast?", audioFileId: "" },
  { topic: "How do you get to work or school?", audioFileId: "" },
  { topic: "What does your typical weekend look like?", audioFileId: "" },
  { topic: "Describe your morning routine", audioFileId: "" },
  { topic: "What do you do before going to bed?", audioFileId: "" },
  { topic: "How do you spend your lunch break?", audioFileId: "" },
  { topic: "What household chores do you do?", audioFileId: "" },
  { topic: "Describe a typical Monday for you", audioFileId: "" },
  { topic: "How has your routine changed over the years?", audioFileId: "" },

  // Hobbies & Interests (21-30)
  { topic: "Talk about your hobbies", audioFileId: "" },
  { topic: "What do you like to do in your free time?", audioFileId: "" },
  { topic: "Do you have any unusual hobbies?", audioFileId: "" },
  { topic: "What hobby would you like to try?", audioFileId: "" },
  { topic: "Tell me about a skill you learned recently", audioFileId: "" },
  { topic: "What sports do you enjoy?", audioFileId: "" },
  { topic: "Do you play any musical instruments?", audioFileId: "" },
  { topic: "What games do you like to play?", audioFileId: "" },
  { topic: "Tell me about your favorite book", audioFileId: "" },
  { topic: "What kind of music do you listen to?", audioFileId: "" },

  // Travel & Places (31-40)
  { topic: "Describe your favorite place", audioFileId: "" },
  { topic: "What was your best vacation?", audioFileId: "" },
  { topic: "Where would you like to travel?", audioFileId: "" },
  { topic: "Describe a memorable trip you took", audioFileId: "" },
  { topic: "What country would you like to visit and why?", audioFileId: "" },
  { topic: "Do you prefer beach or mountain vacations?", audioFileId: "" },
  { topic: "Describe a place you visited that surprised you", audioFileId: "" },
  { topic: "What do you like to do when traveling?", audioFileId: "" },
  { topic: "Tell me about a road trip you took", audioFileId: "" },
  { topic: "Describe the most beautiful place you have seen", audioFileId: "" },

  // Past Experiences (41-50)
  { topic: "What did you do last weekend?", audioFileId: "" },
  { topic: "Tell me about your last birthday", audioFileId: "" },
  { topic: "Describe a challenge you overcame", audioFileId: "" },
  { topic: "What was your most embarrassing moment?", audioFileId: "" },
  { topic: "Tell me about a time you helped someone", audioFileId: "" },
  { topic: "Describe your first job", audioFileId: "" },
  { topic: "What was the best gift you ever received?", audioFileId: "" },
  { topic: "Tell me about a concert or event you attended", audioFileId: "" },
  { topic: "Describe a difficult decision you made", audioFileId: "" },
  { topic: "What was your favorite school subject and why?", audioFileId: "" },

  // Future & Goals (51-60)
  { topic: "What are your goals for this year?", audioFileId: "" },
  { topic: "Where do you see yourself in five years?", audioFileId: "" },
  { topic: "What is your dream job?", audioFileId: "" },
  { topic: "What would you do if you won the lottery?", audioFileId: "" },
  { topic: "What skill do you want to improve?", audioFileId: "" },
  { topic: "What are your career aspirations?", audioFileId: "" },
  { topic: "Do you have any bucket list items?", audioFileId: "" },
  { topic: "What would you like to achieve before you retire?", audioFileId: "" },
  { topic: "If you could learn anything, what would it be?", audioFileId: "" },
  { topic: "What changes do you want to make in your life?", audioFileId: "" },

  // Opinions & Preferences (61-70)
  { topic: "What is your favorite movie and why?", audioFileId: "" },
  { topic: "Do you prefer working from home or in an office?", audioFileId: "" },
  { topic: "What is your favorite season and why?", audioFileId: "" },
  { topic: "Are you a morning person or a night owl?", audioFileId: "" },
  { topic: "What type of food do you enjoy the most?", audioFileId: "" },
  { topic: "Do you prefer city life or country life?", audioFileId: "" },
  { topic: "What is your opinion on social media?", audioFileId: "" },
  { topic: "Coffee or tea? Explain your preference", audioFileId: "" },
  { topic: "What qualities do you value in a friend?", audioFileId: "" },
  { topic: "What is your favorite holiday and how do you celebrate?", audioFileId: "" },

  // Work & Education (71-80)
  { topic: "Describe your current job or studies", audioFileId: "" },
  { topic: "What do you like and dislike about your work?", audioFileId: "" },
  { topic: "Tell me about your educational background", audioFileId: "" },
  { topic: "What motivated you to choose your career?", audioFileId: "" },
  { topic: "Describe your ideal work environment", audioFileId: "" },
  { topic: "What have you learned from your job?", audioFileId: "" },
  { topic: "How do you handle stress at work?", audioFileId: "" },
  { topic: "Tell me about a project you are proud of", audioFileId: "" },
  { topic: "What skills are important in your field?", audioFileId: "" },
  { topic: "Describe your relationship with your colleagues", audioFileId: "" },

  // Technology & Modern Life (81-90)
  { topic: "How has technology changed your life?", audioFileId: "" },
  { topic: "What apps do you use every day?", audioFileId: "" },
  { topic: "Do you think AI will change the world?", audioFileId: "" },
  { topic: "How do you stay informed about news?", audioFileId: "" },
  { topic: "What do you think about online shopping?", audioFileId: "" },
  { topic: "How much time do you spend on your phone?", audioFileId: "" },
  { topic: "What is your favorite website or platform?", audioFileId: "" },
  { topic: "Do you think technology makes life easier or harder?", audioFileId: "" },
  { topic: "How do you protect your privacy online?", audioFileId: "" },
  { topic: "What technology do you wish existed?", audioFileId: "" },

  // Hypothetical & Creative (91-100)
  { topic: "If you could have dinner with anyone, who would it be?", audioFileId: "" },
  { topic: "If you could live in any era, which would you choose?", audioFileId: "" },
  { topic: "What superpower would you want to have?", audioFileId: "" },
  { topic: "If you could change one thing about the world, what would it be?", audioFileId: "" },
  { topic: "Describe your perfect day", audioFileId: "" },
  { topic: "If you could master any skill instantly, what would it be?", audioFileId: "" },
  { topic: "What advice would you give to your younger self?", audioFileId: "" },
  { topic: "If you could live anywhere, where would you choose?", audioFileId: "" },
  { topic: "What would you do if you had an extra hour every day?", audioFileId: "" },
  { topic: "If you could start a business, what would it be?", audioFileId: "" },
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
  }

  console.log(`Successfully seeded ${prompts.length} prompts.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
