import { task } from "@trigger.dev/sdk";
import * as fs from "fs";
import * as path from "path";

interface VideoSummaryInput {
  videoUrl: string;
}

export const videoSummaryTask = task({
  id: "video-summary",
  run: async (payload: VideoSummaryInput) => {
    const { videoUrl } = payload;

    const youtubeApiKey = process.env.YOUTUBE_API_KEY;
    const mistralApiKey = process.env.MISTRAL_API_KEY;

    if (!youtubeApiKey) throw new Error("YOUTUBE_API_KEY is not set");
    if (!mistralApiKey) throw new Error("MISTRAL_API_KEY is not set");

    const videoId = extractVideoId(videoUrl);
    if (!videoId) throw new Error("Invalid YouTube URL");

    console.log(`Processing video: ${videoId}`);

    // Step 1: Get video metadata
    const videoData = await getVideoMetadata(videoId, youtubeApiKey);
    const videoTitle = videoData.title;

    console.log(`Video title: ${videoTitle}`);

    // Step 2: Get transcript via free API
    const transcript = await getTranscript(videoId);
    if (!transcript) {
      throw new Error("Could not extract transcript from video");
    }

    console.log(`Transcript extracted: ${transcript.substring(0, 100)}...`);

    // Step 3: Summarize transcript with Mistral
    const summary = await summarizeTranscript(mistralApiKey, transcript);

    // Step 4: Generate Mermaid diagrams from transcript content
    const diagrams = await generateDiagrams(mistralApiKey, transcript);

    // Step 5: Generate markdown output
    const markdown = generateMarkdown(videoTitle, summary, diagrams);

    console.log("\n=== VIDEO SUMMARY ===\n");
    console.log(markdown);

    return {
      videoId,
      videoTitle,
      summary,
      markdown,
    };
  },
});

function extractVideoId(url: string): string | null {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&\n?#]+)/,
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }

  return null;
}

async function getVideoMetadata(
  videoId: string,
  apiKey: string
): Promise<{ title: string; description: string; duration: string }> {
  const url = `https://www.googleapis.com/youtube/v3/videos?id=${videoId}&key=${apiKey}&part=snippet,contentDetails`;

  try {
    const response = await fetch(url);
    const data = (await response.json()) as any;
    const items = data.items;

    if (!items || items.length === 0) {
      throw new Error("Video not found");
    }

    const snippet = items[0].snippet;
    return {
      title: snippet.title,
      description: snippet.description,
      duration: items[0].contentDetails.duration,
    };
  } catch (error) {
    console.error("Error fetching video metadata:", error);
    throw new Error("Failed to fetch video metadata");
  }
}

async function getTranscript(videoId: string): Promise<string> {
  try {
    const response = await fetch(`https://www.youtube.com/watch?v=${videoId}`);
    const html = await response.text();

    const captionsMatch = html.match(/"captions":\s*(\{[^}]+\})/);
    if (!captionsMatch) {
      console.log("No captions found, trying alternative method...");
      return await getTranscriptFromYoutubeDirect(videoId);
    }

    const captionsJson = JSON.parse(captionsMatch[1]);
    const trackUrl = captionsJson?.playerCaptionsTracklistRenderer?.tracks?.[0]?.baseUrl;

    if (!trackUrl) {
      return await getTranscriptFromYoutubeDirect(videoId);
    }

    const captionResponse = await fetch(trackUrl);
    const captionText = await captionResponse.text();

    let transcript = captionText
      .replace(/<[^>]+>/g, "")
      .split("\n")
      .filter(line => line.trim().length > 0)
      .join(" ");

    return transcript;
  } catch (error) {
    console.error("Error fetching transcript from page:", error);
    return await getTranscriptFromYoutubeDirect(videoId);
  }
}

async function getTranscriptFromYoutubeDirect(videoId: string): Promise<string> {
  try {
    const response = await fetch(
      `https://www.youtube.com/api/timedtext?v=${videoId}&lang=en&fmt=vtt`
    );

    if (!response.ok) {
      throw new Error("Failed to fetch transcript");
    }

    const vttContent = await response.text();
    let transcript = vttContent
      .replace(/WEBVTT\n\n/, "")
      .replace(/^\d{2}:\d{2}:\d{2}\.\d{3} --> \d{2}:\d{2}:\d{2}\.\d{3}\n/gm, "")
      .replace(/\n\n/g, " ")
      .replace(/<[^>]+>/g, "");

    return transcript;
  } catch (error) {
    console.error("Error fetching transcript directly:", error);
    return "";
  }
}

async function summarizeTranscript(
  mistralApiKey: string,
  transcript: string
): Promise<string> {
  try {
    const response = await fetch("https://api.mistral.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${mistralApiKey}`,
      },
      body: JSON.stringify({
        model: "mistral-small-latest",
        messages: [
          {
            role: "user",
            content: `Summarize the following video transcript into a nested bulleted list.
Each main topic should be a top-level bullet, with key points as sub-bullets.
Keep each point to 1-2 sentences maximum.

Transcript:
${transcript}

Format the output as a clean bulleted markdown list.`,
          },
        ],
      }),
    });

    const data = (await response.json()) as any;
    return data.choices[0].message.content;
  } catch (error) {
    console.error("Error summarizing transcript:", error);
    throw new Error("Failed to summarize transcript");
  }
}

async function generateDiagrams(
  mistralApiKey: string,
  transcript: string
): Promise<string> {
  try {
    const response = await fetch("https://api.mistral.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${mistralApiKey}`,
      },
      body: JSON.stringify({
        model: "mistral-small-latest",
        messages: [
          {
            role: "user",
            content: `Based on this video transcript, create 1-2 Mermaid diagrams that visualize the key concepts or processes.
Choose the most appropriate diagram type (flowchart, graph, mindmap, etc.).
Provide ONLY the Mermaid code blocks, no explanation.

Transcript excerpt:
${transcript.substring(0, 2000)}...

Format each diagram as:
\`\`\`mermaid
[diagram code]
\`\`\``,
          },
        ],
      }),
    });

    const data = (await response.json()) as any;
    return data.choices[0].message.content;
  } catch (error) {
    console.error("Error generating diagrams:", error);
    return "";
  }
}

function generateMarkdown(
  title: string,
  summary: string,
  diagrams: string
): string {
  let markdown = `# ${title}\n\n`;

  markdown += `## Summary\n\n${summary}\n\n`;

  if (diagrams && diagrams.trim().length > 0) {
    markdown += `## Concept Diagrams\n\n${diagrams}\n\n`;
  }

  return markdown;
}
