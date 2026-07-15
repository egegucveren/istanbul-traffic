import React from 'react';
import { render, screen } from '@testing-library/react';
import App from './App';

// @react-google-maps/api's <LoadScript> only renders its children after the
// real Google Maps script has loaded, which never happens in jsdom. Mock the
// library with simple passthroughs so the panel renders synchronously in tests.
jest.mock('@react-google-maps/api', () => ({
  LoadScript: ({ children }: any) => <>{children}</>,
  GoogleMap: ({ children }: any) => <div>{children}</div>,
  TrafficLayer: () => null,
  Autocomplete: ({ children }: any) => <>{children}</>,
  Marker: () => null,
  Polyline: () => null,
}));

test('renders the traffic assistant side panel', () => {
  render(<App />);
  expect(screen.getByText(/Yol Asistanı/i)).toBeInTheDocument();
});

test('renders the weather section', () => {
  render(<App />);
  expect(screen.getByText(/Hava Durumu/i)).toBeInTheDocument();
});

test('disables the route button until origin and destination are picked', () => {
  render(<App />);
  const button = screen.getByRole('button', { name: /Rota Hesapla/i });
  expect(button).toBeDisabled();
});
