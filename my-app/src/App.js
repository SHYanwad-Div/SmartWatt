// src/App.js
import React, { useEffect, useState } from 'react';
import axios from 'axios';
import Navbar from './components/Navbar';
import OverviewCards from './components/OverviewCards';
import PowerChart from './components/PowerChart';
import ChatbotDrawer from './components/ChatbotDrawer';
import { Container, Box, Paper, Typography } from '@mui/material';

function App() {
  const device = 'esp32-smartwatt-001';
  const [summary, setSummary] = useState([]);
  const [events, setEvents] = useState([]);
  const [openChat, setOpenChat] = useState(false);

  useEffect(() => {
    fetchSummary(); fetchEvents();
    const t = setInterval(()=>{ fetchSummary(); fetchEvents(); }, 5000);
    return ()=> clearInterval(t);
  }, []);

  const fetchSummary = async () => {
    try {
      const r = await axios.get(`http://localhost:3000/api/summary/${device}?range=24h`);
      setSummary(r.data || []);
    } catch(e){ console.error(e); }
  };
  const fetchEvents = async () => {
    try {
      const r = await axios.get(`http://localhost:3000/api/events/${device}`);
      setEvents(r.data || []);
    } catch(e){ console.error(e); }
  };

  const points = (summary || []).map(s => ({ ts_ms: new Date(s.time).getTime(), value: s.mean_power ?? 0 }));
  const latest = points.length ? points[points.length-1].value : 0;

  async function simulate() {
    try {
      const body = {
        device_id: device,
        ts_ms: Date.now(),
        voltage_V: 230,
        current_A: +(latest/230).toFixed(2),
        power_W: Math.max(50, Math.round(latest + Math.random()*300)),
        energyWh_total: 0,
        deltaW: 120
      };
      await axios.post('http://localhost:3000/mock_reading', body);
    } catch(e){ console.error(e); }
  }

  return (
    <>
      <Navbar onOpenChat={()=>setOpenChat(true)} onSimulate={simulate} />
      <Container sx={{ mt: 3 }}>
        <Box className="app-hero">
          <Typography variant="h4" sx={{ mb: 1 }}>SmartWatt Dashboard</Typography>
          <OverviewCards totalPower={latest} todayKWh={0} threshold={2000} />
        </Box>

        <Paper sx={{ p: 2, mb: 2 }}>
          <Typography variant="subtitle1" sx={{ mb: 1 }}>Power (hourly)</Typography>
          <PowerChart points={points} />
        </Paper>

        <Typography variant="h6" sx={{ mt: 2, mb: 1 }}>Detected Events (recent)</Typography>
        <Paper sx={{ p: 1 }}>
          <table className="events-table">
            <thead><tr><th>ID</th><th>ts</th><th>deltaW</th><th>direction</th><th>label</th></tr></thead>
            <tbody>
              {events.map(ev => (
                <tr key={ev.id}>
                  <td>{ev.id}</td>
                  <td>{new Date(ev.ts).toLocaleString()}</td>
                  <td>{(ev.deltaW||0).toFixed(1)}</td>
                  <td>{ev.direction}</td>
                  <td>{ev.label_id || '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Paper>

        <ChatbotDrawer open={openChat} onClose={()=>setOpenChat(false)} currentPower={latest} />
      </Container>
    </>
  );
}

export default App;
