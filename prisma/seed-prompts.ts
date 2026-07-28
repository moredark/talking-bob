import { PrismaClient } from "@prisma/client";

const prompts = [
  // Personal Introduction & Background (1-10)
  { topic: "Introduce yourself" },
  { topic: "Tell me about your family" },
  { topic: "Where are you from? Describe your hometown" },
  { topic: "What do you do for a living?" },
  { topic: "Describe your best friend" },
  { topic: "What are your strengths and weaknesses?" },
  { topic: "Tell me about your childhood" },
  { topic: "What languages do you speak?" },
  { topic: "Describe your personality" },
  { topic: "What makes you unique?" },

  // Daily Life & Routines (11-20)
  { topic: "Describe your daily routine" },
  { topic: "What do you usually have for breakfast?" },
  { topic: "How do you get to work or school?" },
  { topic: "What does your typical weekend look like?" },
  { topic: "Describe your morning routine" },
  { topic: "What do you do before going to bed?" },
  { topic: "How do you spend your lunch break?" },
  { topic: "What household chores do you do?" },
  { topic: "Describe a typical Monday for you" },
  { topic: "How has your routine changed over the years?" },

  // Hobbies & Interests (21-30)
  { topic: "Talk about your hobbies" },
  { topic: "What do you like to do in your free time?" },
  { topic: "Do you have any unusual hobbies?" },
  { topic: "What hobby would you like to try?" },
  { topic: "Tell me about a skill you learned recently" },
  { topic: "What sports do you enjoy?" },
  { topic: "Do you play any musical instruments?" },
  { topic: "What games do you like to play?" },
  { topic: "Tell me about your favorite book" },
  { topic: "What kind of music do you listen to?" },

  // Travel & Places (31-40)
  { topic: "Describe your favorite place" },
  { topic: "What was your best vacation?" },
  { topic: "Where would you like to travel?" },
  { topic: "Describe a memorable trip you took" },
  { topic: "What country would you like to visit and why?" },
  { topic: "Do you prefer beach or mountain vacations?" },
  { topic: "Describe a place you visited that surprised you" },
  { topic: "What do you like to do when traveling?" },
  { topic: "Tell me about a road trip you took" },
  { topic: "Describe the most beautiful place you have seen" },

  // Past Experiences (41-50)
  { topic: "What did you do last weekend?" },
  { topic: "Tell me about your last birthday" },
  { topic: "Describe a challenge you overcame" },
  { topic: "What was your most embarrassing moment?" },
  { topic: "Tell me about a time you helped someone" },
  { topic: "Describe your first job" },
  { topic: "What was the best gift you ever received?" },
  { topic: "Tell me about a concert or event you attended" },
  { topic: "Describe a difficult decision you made" },
  { topic: "What was your favorite school subject and why?" },

  // Future & Goals (51-60)
  { topic: "What are your goals for this year?" },
  { topic: "Where do you see yourself in five years?" },
  { topic: "What is your dream job?" },
  { topic: "What would you do if you won the lottery?" },
  { topic: "What skill do you want to improve?" },
  { topic: "What are your career aspirations?" },
  { topic: "Do you have any bucket list items?" },
  { topic: "What would you like to achieve before you retire?" },
  { topic: "If you could learn anything, what would it be?" },
  { topic: "What changes do you want to make in your life?" },

  // Opinions & Preferences (61-70)
  { topic: "What is your favorite movie and why?" },
  { topic: "Do you prefer working from home or in an office?" },
  { topic: "What is your favorite season and why?" },
  { topic: "Are you a morning person or a night owl?" },
  { topic: "What type of food do you enjoy the most?" },
  { topic: "Do you prefer city life or country life?" },
  { topic: "What is your opinion on social media?" },
  { topic: "Coffee or tea? Explain your preference" },
  { topic: "What qualities do you value in a friend?" },
  { topic: "What is your favorite holiday and how do you celebrate?" },

  // Work & Education (71-80)
  { topic: "Describe your current job or studies" },
  { topic: "What do you like and dislike about your work?" },
  { topic: "Tell me about your educational background" },
  { topic: "What motivated you to choose your career?" },
  { topic: "Describe your ideal work environment" },
  { topic: "What have you learned from your job?" },
  { topic: "How do you handle stress at work?" },
  { topic: "Tell me about a project you are proud of" },
  { topic: "What skills are important in your field?" },
  { topic: "Describe your relationship with your colleagues" },

  // Technology & Modern Life (81-90)
  { topic: "How has technology changed your life?" },
  { topic: "What apps do you use every day?" },
  { topic: "Do you think AI will change the world?" },
  { topic: "How do you stay informed about news?" },
  { topic: "What do you think about online shopping?" },
  { topic: "How much time do you spend on your phone?" },
  { topic: "What is your favorite website or platform?" },
  { topic: "Do you think technology makes life easier or harder?" },
  { topic: "How do you protect your privacy online?" },
  { topic: "What technology do you wish existed?" },

  // Hypothetical & Creative (91-100)
  { topic: "If you could have dinner with anyone, who would it be?" },
  { topic: "If you could live in any era, which would you choose?" },
  { topic: "What superpower would you want to have?" },
  { topic: "If you could change one thing about the world, what would it be?" },
  { topic: "Describe your perfect day" },
  { topic: "If you could master any skill instantly, what would it be?" },
  { topic: "What advice would you give to your younger self?" },
  { topic: "If you could live anywhere, where would you choose?" },
  { topic: "What would you do if you had an extra hour every day?" },
  { topic: "If you could start a business, what would it be?" },
];

export async function seedPrompts(prisma: PrismaClient): Promise<void> {
  console.log("Seeding prompts...");

  for (const prompt of prompts) {
    const existingPrompt = await prisma.prompt.findFirst({
      where: { topic: prompt.topic },
      select: { id: true },
    });

    if (existingPrompt) {
      continue;
    }

    await prisma.prompt.create({
      data: {
        topic: prompt.topic,
        audioFileId: null,
        isActive: true,
      },
    });
  }

  console.log(`Prompt seed checked ${prompts.length} built-in prompts.`);
}
