// api/getTweets.js
import fetch from 'node-fetch';

export default async function handler(req, res) {
  const BEARER_TOKEN = process.env.TWITTER_BEARER_TOKEN; // must be set in Vercel Environment Variables

  try {
    const response = await fetch(
      'https://api.twitter.com/2/users/by/username/JAMBHQ/tweets?max_results=5&tweet.fields=created_at',
      {
        headers: {
          'Authorization': `Bearer ${BEARER_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(errText);
    }

    const data = await response.json();

    // Simplify tweets for frontend
    const tweets = data.data.map(tweet => ({
      id: tweet.id,
      text: tweet.text,
      created_at: tweet.created_at,
      user: { username: 'JAMBHQ' }
    }));

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(200).json(tweets);

  } catch (err) {
    console.error('Error fetching tweets:', err);
    res.status(500).json({ error: 'Failed to fetch tweets' });
  }
}
