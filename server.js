const express = require('express');
const app = express();

app.use(express.json());

app.get('/', (req, res) => {
  res.status(200).json({ status: 'ok', message: 'API is running successfully!' });
});

app.post('/api/info', (req, res) => {
  const { url } = req.body;
  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }
  res.json({
    title: 'Video Title',
    directUrl: 'https://www.w3schools.com/html/mov_bbb.mp4',
    formats: [{ url: 'https://www.w3schools.com/html/mov_bbb.mp4', ext: 'mp4', resolution: 'HD' }]
  });
});

module.exports = app;
