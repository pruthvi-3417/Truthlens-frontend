import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import AppLayout from './components/layout/AppLayout';
import Landing from './pages/Landing';
import Dashboard from './pages/Dashboard';
import Analyze from './pages/Analyze';
import Processing from './pages/Processing';
import Results from './pages/Results';
import History from './pages/History';
import Methods from './pages/Methods';
import Reports from './pages/Reports';
import About from './pages/About';
import Settings from './pages/Settings';

export default function App(){return <BrowserRouter><Routes><Route path="/" element={<Landing/>}/><Route element={<AppLayout/>}><Route path="dashboard" element={<Dashboard/>}/><Route path="analyze" element={<Analyze/>}/><Route path="processing" element={<Processing/>}/><Route path="results" element={<Results/>}/><Route path="history" element={<History/>}/><Route path="methods" element={<Methods/>}/><Route path="reports" element={<Reports/>}/><Route path="about" element={<About/>}/><Route path="settings" element={<Settings/>}/></Route><Route path="*" element={<Navigate to="/dashboard" replace/>}/></Routes></BrowserRouter>}
