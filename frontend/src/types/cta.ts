export type Train = {
  id: string;
  line: string;
  lat: number;
  lng: number;
  nextStopId: string;
  nextStopName?: string | null;
  timestamp: number;
};

export type ArrivalEvent = {
  type: "arrival";
  line: string;
  stopId: string;
  timestamp: number;
};

export type TrainUpdateEvent = {
  type: "train_update";
  trains: Train[];
  timestamp: number;
};

export type CTAEvent = ArrivalEvent | TrainUpdateEvent;

export type CTAStop = {
  id: string;
  name: string;
  lat: number;
  lng: number;
  lines: string[];
};

export type CTARoute = {
  line: string;
  color: string;
  coordinates: [number, number][];
  segments?: [number, number][][];
};

export type CTAStaticData = {
  stops: CTAStop[];
  routes: CTARoute[];
};
