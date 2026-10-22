import React from "react";
import {Composition} from "remotion";
import {DevFathomFilm} from "./DevFathomFilm";
import {ConceptFilm, CONCEPTS} from "./TenConcepts";

export const RemotionRoot: React.FC = () => (
  <>
    <Composition
      id="DevFathomFilm"
      component={DevFathomFilm}
      durationInFrames={720}
      fps={30}
      width={1920}
      height={1080}
    />
    {CONCEPTS.map((concept) => (
      <Composition
        key={concept.id}
        id={concept.id}
        component={ConceptFilm}
        defaultProps={{concept: concept.index}}
        durationInFrames={450}
        fps={30}
        width={1920}
        height={1080}
      />
    ))}
  </>
);
