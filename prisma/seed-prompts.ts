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

  // Food & Cooking (101-110)
  { topic: "What dish do you enjoy cooking, and how do you make it?" },
  { topic: "Describe a meal that reminds you of home" },
  { topic: "What would you cook for a friend visiting for dinner?" },
  { topic: "Tell me about a food you tried for the first time recently" },
  { topic: "How do you choose a restaurant when eating out?" },
  { topic: "What local dish would you recommend to a visitor?" },
  { topic: "Describe a time when cooking did not go as planned" },
  { topic: "What ingredients do you always keep in your kitchen?" },
  { topic: "How have your food preferences changed since childhood?" },
  { topic: "What would you serve at a picnic with friends?" },

  // Home & Living Spaces (111-120)
  { topic: "Describe the room where you feel most comfortable" },
  { topic: "What makes a house or apartment feel like home?" },
  { topic: "How would you decorate an empty room?" },
  { topic: "What do you like about the neighborhood you live in?" },
  { topic: "Describe something in your home that has a special story" },
  { topic: "What would you change about your home if you could?" },
  { topic: "What advice would you give someone moving into their first apartment?" },
  { topic: "How would you make a guest feel welcome in your home?" },
  { topic: "What would you look for when choosing a new place to live?" },
  { topic: "What rules would help people share a home comfortably?" },

  // Wellbeing & Everyday Habits (121-130)
  { topic: "What helps you relax after a busy day?" },
  { topic: "How do you stay active when you have little free time?" },
  { topic: "What small habit makes your day better?" },
  { topic: "How do you notice that you need a break?" },
  { topic: "Describe your favorite way to spend time outdoors" },
  { topic: "What helps you get a good night's sleep?" },
  { topic: "How do you motivate yourself when you feel tired?" },
  { topic: "What does a balanced week look like for you?" },
  { topic: "Tell me about a habit you successfully changed" },
  { topic: "What do you do to cheer yourself up on a difficult day?" },

  // City Life & Public Spaces (131-140)
  { topic: "What is the best way to explore your city without a car?" },
  { topic: "Describe a public place where you enjoy spending time" },
  { topic: "What would make public transport more comfortable?" },
  { topic: "What would you show a visitor who had only one afternoon in your city?" },
  { topic: "How could your neighborhood become more welcoming?" },
  { topic: "What kinds of events bring people together where you live?" },
  { topic: "Describe your ideal park" },
  { topic: "What do you enjoy noticing when you walk around a new area?" },
  { topic: "How would you improve a busy street near your home?" },
  { topic: "What small local business would you like to see in your neighborhood?" },

  // Shopping & Everyday Choices (141-150)
  { topic: "How do you decide whether something is worth buying?" },
  { topic: "Tell me about a purchase that turned out to be very useful" },
  { topic: "What do you prefer to buy secondhand, and why?" },
  { topic: "How do you choose a gift for someone you do not know well?" },
  { topic: "Describe a time when you repaired something instead of replacing it" },
  { topic: "What makes a shopping experience pleasant for you?" },
  { topic: "How do you avoid buying things you do not need?" },
  { topic: "What is something you prefer to borrow rather than own?" },
  { topic: "What would you consider before making a large purchase?" },
  { topic: "What matters most to you when choosing clothes?" },

  // Nature & Animals (151-160)
  { topic: "Describe an animal you find interesting" },
  { topic: "What do you enjoy about spending time near water?" },
  { topic: "How does the weather affect your plans?" },
  { topic: "What would you like to learn about caring for plants?" },
  { topic: "Describe a memorable encounter with an animal" },
  { topic: "What should someone consider before getting a pet?" },
  { topic: "How does your neighborhood change with the seasons?" },
  { topic: "What small steps could help people produce less waste?" },
  { topic: "What would you pack for a day in the countryside?" },
  { topic: "What natural place would you like to protect, and why?" },

  // Culture & Entertainment (161-170)
  { topic: "What fictional character would you enjoy meeting?" },
  { topic: "Describe a tradition you would like to share with a foreign friend" },
  { topic: "What makes a story interesting to you?" },
  { topic: "Tell me about a museum or exhibition you would like to visit" },
  { topic: "What song brings back a particular memory for you?" },
  { topic: "How do you choose what to watch when you have a free evening?" },
  { topic: "What kind of live performance would you like to attend?" },
  { topic: "Describe a celebration you would enjoy organizing" },
  { topic: "What can people learn about a culture through its food?" },
  { topic: "If your life were a movie, what kind of movie would it be?" },

  // Communication & Relationships (171-180)
  { topic: "How do you keep in touch with friends who live far away?" },
  { topic: "What helps you start a conversation with someone new?" },
  { topic: "Tell me about a piece of advice that helped you" },
  { topic: "How do you prefer to celebrate a friend's success?" },
  { topic: "What makes someone a good listener?" },
  { topic: "Describe a time when teamwork made something easier" },
  { topic: "How would you politely disagree with a friend?" },
  { topic: "What is a thoughtful way to thank someone for their help?" },
  { topic: "What helps you explain an idea when someone does not understand it?" },
  { topic: "What activity would you suggest for getting to know a new colleague?" },

  // Learning & Curiosity (181-190)
  { topic: "How would you explain your hobby to a complete beginner?" },
  { topic: "What topic could you happily talk about for an hour?" },
  { topic: "What helps you remember new English words?" },
  { topic: "Describe a time when making a mistake taught you something useful" },
  { topic: "How do you find answers when you are curious about something?" },
  { topic: "What would you enjoy teaching other people?" },
  { topic: "What makes it easier for you to concentrate?" },
  { topic: "How would you plan a week of English practice?" },
  { topic: "What everyday task would you like to understand better?" },
  { topic: "Tell me about something you used to find difficult but now find easy" },

  // Everyday Roleplay (191-200)
  { topic: "Imagine you are checking into a hotel. What would you ask the receptionist?" },
  { topic: "Imagine a restaurant brings you the wrong meal. How would you explain the problem?" },
  { topic: "Imagine a tourist asks for directions to the nearest station. How would you help?" },
  { topic: "Imagine you need to reschedule an appointment. What would you say on the phone?" },
  { topic: "Imagine your luggage is missing at the airport. How would you describe it?" },
  { topic: "Imagine you are inviting a neighbor to a weekend gathering. What would you say?" },
  { topic: "Imagine you want to return a broken item to a shop. How would you explain what happened?" },
  { topic: "Imagine a friend is visiting your home for the first time. How would you explain how to get there?" },
  { topic: "Imagine you arrive late for a meeting. How would you explain the delay?" },
  { topic: "Imagine you are ordering lunch at a cafe. How would you ask about the ingredients?" },
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
