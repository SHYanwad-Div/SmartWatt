// src/theme.js
import { createTheme } from '@mui/material/styles';

const theme = createTheme({
  palette: {
    mode: 'light',
    primary: { main: '#ff9eb5' },   // millennial pink
    secondary: { main: '#78c6a3' }, // pastel mint
    info: { main: '#ffc7d9' },
    background: {
      default: '#fff2e6',
      paper: '#ffffffaa'
    },
    text: {
      primary: '#2b2b2b',
      secondary: '#555'
    }
  },
  typography: {
    fontFamily: '"Poppins", "Inter", "Roboto", sans-serif'
  },
  components: {
    MuiPaper: {
      styleOverrides: {
        root: {
          borderRadius: 14,
          boxShadow: '0 8px 24px rgba(0,0,0,0.06)',
          border: '1px solid rgba(255,255,255,0.6)'
        }
      }
    },
    MuiAppBar: {
      styleOverrides: {
        root: {
          boxShadow: '0 6px 18px rgba(0,0,0,0.06)'
        }
      }
    }
  }
});

export default theme;
