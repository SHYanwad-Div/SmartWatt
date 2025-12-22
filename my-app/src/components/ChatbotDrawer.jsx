// src/components/ChatbotDrawer.jsx
import React, { useState, useEffect } from 'react';
import { Drawer, Box, IconButton, Typography, TextField, Button, List, ListItem, ListItemText } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import axios from 'axios';

export default function ChatbotDrawer({ open, onClose, currentPower }) {
  const [messages, setMessages] = useState([{ from: 'bot', text: "Hi! I'm your Energy Assistant. Ask about weather or energy tips." }]);
  const [input, setInput] = useState('');
  const [location, setLocation] = useState({ lat: 12.9716, lon: 77.5946 });

  useEffect(()=> {
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(p => setLocation({ lat: p.coords.latitude, lon: p.coords.longitude }), ()=>{});
    }
  }, []);

  const pushBot = (t) => setMessages(m => [...m, { from: 'bot', text: t }]);
  const pushUser = (t) => setMessages(m => [...m, { from: 'user', text: t }]);

  async function getWeather() {
    try {
      const r = await axios.get(`/weather?lat=${location.lat}&lon=${location.lon}`);
      return r.data;
    } catch(e){ return null; }
  }

  async function handleWeatherTips() {
    pushUser('weather?');
    const w = await getWeather();
    if (!w) return pushBot('Could not fetch weather now.');
    const temp = w.main.temp;
    pushBot(`Current ${w.name}: ${temp}°C, ${w.weather[0].description}`);
    if (temp >= 30 && currentPower > 1500) pushBot('It is hot and your power is high — reduce AC, prefer fans, delay heavy loads.');
    else if (currentPower > 2000) pushBot('Total power is high — switch off non-essential devices.');
    else pushBot('Usage looks normal. Consider running heavy loads during off-peak.');
  }

  async function sendMessage() {
    if (!input.trim()) return;
    pushUser(input.trim());
    const text = input.trim().toLowerCase();
    setInput('');
    if (/(weather|temp|rain)/.test(text)) { await handleWeatherTips(); return; }
    if (/(suggest|advice|save|energy)/.test(text)) {
      const w = await getWeather();
      const temp = w?.main?.temp;
      if (temp >= 30 && currentPower > 1500) pushBot('Hot + high usage — lower AC use, prefer fan.');
      else if (currentPower > 2000) pushBot('High usage — reduce non-essential loads.');
      else pushBot('Low usage — good. Keep monitoring.');
      return;
    }
    // fallback FAQ
    if (text.includes('calib')) pushBot('To calibrate, measure a known load and adjust constants in ESP32 code.');
    else pushBot("I can help with weather-based tips, calibration guidance, or explain readings.");
  }

  return (
    <Drawer anchor="right" open={open} onClose={onClose}>
      <Box sx={{ width: 360, p: 2 }}>
        <Box sx={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
          <Typography variant="h6">Energy Assistant</Typography>
          <IconButton onClick={onClose}><CloseIcon /></IconButton>
        </Box>
        <List sx={{ height: '60vh', overflow: 'auto', p: 1 }}>
          {messages.map((m,i) => (
            <ListItem key={i} sx={{ justifyContent: m.from==='bot' ? 'flex-start' : 'flex-end' }}>
              <Box className="chat-bubble" sx={{ maxWidth: '78%' }}>
                <ListItemText primary={m.text} />
              </Box>
            </ListItem>
          ))}
        </List>

        <Box sx={{ display: 'flex', gap: 1 }}>
          <TextField value={input} onChange={e=>setInput(e.target.value)} placeholder="Ask about weather or energy tips..." fullWidth />
          <Button variant="contained" onClick={sendMessage} sx={{ background: 'linear-gradient(90deg,#ff9eb5,#ffc7d9)' }}>Send</Button>
        </Box>

        <Box sx={{ mt: 1, display: 'flex', gap: 1 }}>
          <Button variant="outlined" onClick={handleWeatherTips}>Weather tips</Button>
        </Box>
      </Box>
    </Drawer>
  );
}
