import { videoSummaryTask } from "./src/trigger/video-summary/index.ts";

// Test the task locally without Trigger.dev dev server
async function testLocally() {
  try {
    console.log("🎬 Starting local video summary test...\n");

    // Use a test YouTube URL (replace with your own)
    const testUrl = process.argv[2] || "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

    console.log(`📹 Video URL: ${testUrl}\n`);

    // Run the task
    const result = await videoSummaryTask.run({
      videoUrl: testUrl,
    });

    console.log("\n✅ Test completed successfully!");
    console.log("\n📊 Result:");
    console.log(JSON.stringify(result, null, 2));

  } catch (error) {
    console.error("\n❌ Error:", error.message);
    console.error(error);
    process.exit(1);
  }
}

testLocally();
