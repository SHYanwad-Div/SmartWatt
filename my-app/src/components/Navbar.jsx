// src/components/Navbar.jsx
import React from 'react';
import { AppBar, Toolbar, IconButton, Typography, Box } from '@mui/material';
import MenuIcon from '@mui/icons-material/Menu';
import ChatBubbleOutlineIcon from '@mui/icons-material/ChatBubbleOutline';

export default function Navbar({ onOpenChat, onSimulate }) {
  return (
    <AppBar position="sticky" sx={{
      background: "linear-gradient(90deg,#ff9eb5,#ffc7d9)",
      color: '#2b2b2b'
    }}>
      <Toolbar>
        <IconButton edge="start" color="inherit" aria-label="menu" sx={{ mr: 2 }}>
          <MenuIcon />
        </IconButton>
        <Typography variant="h6" sx={{ flexGrow: 1 }}>
          SmartWatt
        </Typography>

        <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
          <button className="sim-btn" onClick={onSimulate}>Simulate</button>
          <IconButton color="inherit" onClick={onOpenChat}>
            <ChatBubbleOutlineIcon />
          </IconButton>
        </Box>
      </Toolbar>
    </AppBar>
  );
}
