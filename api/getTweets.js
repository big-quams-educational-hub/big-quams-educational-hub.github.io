import fetch from 'node-fetch';

export default async function handler(req, res) {
  const BEARER_TOKEN = process.env.TWITTER_BEARER_TOKEN;

  // Get JAMBHQ user ID
  const userResponse = await fetch('https://api.twitter.com/2/users/by/username/JAMBHQ', {
    headers: { Authorization: `Bearer ${BEARER_TOKEN}` }
  });
  const userData = await userResponse.json();
  const userId = userData.data.id;

  // Fetch latest 5 tweets excluding replies/retweets
  const tweetsResponse = await fetch(
    `https://api.twitter.com/2/users/${userId}/tweets?max_results=5&exclude=replies,retweets`,
    { headers: { Authorization: `Bearer ${BEARER_TOKEN}` } }
  );
  const tweetsData = await tweetsResponse.json();

  // Take only last 2 tweets
  const latestTwo = tweetsData.data.slice(0, 2);

  // Return JSON with CORS header
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(200).json(latestTwo);
}
